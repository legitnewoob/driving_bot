/**
 * Phase 1 of PLAN-bot-improvements.md:
 *  1.1 concurrent messages keep their own instructor
 *  1.2 learners can only touch their own bookings; ids are unique and retried
 *  1.3 webhook acknowledges first and skips repeated message ids
 *  1.4 one booking per slot, enforced by the database
 *  1.5 conversations persist to Mongo and are processed in order per learner
 */

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/processedMessageModel");
jest.mock("../../src/models/conversationSessionModel");
jest.mock("../../src/models/notificationModel");
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => false) }));
jest.mock("../../src/services/calendarService", () => ({
  createEvent: jest.fn(),
  updateEvent: jest.fn(),
  deleteEvent: jest.fn(),
  getEventsForDate: jest.fn().mockResolvedValue([]),
  checkSlotAgainstEvents: jest.fn().mockReturnValue({ isAvailable: true }),
  findEarliestAvailableSlot: jest.fn(),
  getAvailableTimeSlotsForDate: jest.fn(),
}));
jest.mock("../../src/services/routeOptimizer", () => ({
  evaluateSlot: jest.fn().mockResolvedValue(null),
  findEarliestOfferedSlot: jest.fn(),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({ lat: 53.02, lng: -2.22 }),
}));
jest.mock("../../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}),
  markReadAndTyping: jest.fn().mockResolvedValue(),
}));
jest.mock("../../src/utils/emailNotifier", () => ({
  sendNotification: jest.fn().mockResolvedValue(true),
  notifyInstructorLearnerMessage: jest.fn().mockResolvedValue(true),
  notifyInvalidGrant: jest.fn(),
  notifyInstructorReauth: jest.fn(),
}));
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/chatLogger", () => jest.fn(() => ({ info: jest.fn() })));
jest.mock("../../src/utils/dbChatLogger", () => jest.fn(() => ({ user: jest.fn(), assistant: jest.fn() })));
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({ generateContent: jest.fn() }),
  })),
}));

const mockInstructors = {
  "inst-A": { phoneNumberId: "inst-A", name: "Alice", email: "a@x.com", availableTimes: ["09:00", "10:00", "14:00"] },
  "inst-B": { phoneNumberId: "inst-B", name: "Bob", email: "b@x.com", availableTimes: ["09:00", "10:00", "14:00"] },
};
jest.mock("../../src/models/instructorModel", () => {
  const actual = jest.requireActual("../../src/models/instructorModel");
  return {
    ...actual,
    getInstructor: jest.fn(async (id) => mockInstructors[id] || null),
    getAvailableDates: jest.fn(() => ["2030-07-01", "2030-07-02"]),
  };
});

const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const ProcessedMessage = require("../../src/models/processedMessageModel");
const ConversationSession = require("../../src/models/conversationSessionModel");
const db = require("../../src/utils/db");
const calendarService = require("../../src/services/calendarService");
const whatsappService = require("../../src/services/whatsappService");
const aiService = require("../../src/services/gemini/aiService");
const bookingService = require("../../src/services/bookingService");
const sessionStore = require("../../src/services/sessionStore");
const webhookController = require("../../src/controllers/webhookController");
const { userSessions } = require("../../src/models/instructorModel");
const { runExclusive } = require("../../src/utils/keyedQueue");

const learner = (phone, instructorId) => ({
  phone,
  instructorId,
  name: `Learner ${phone}`,
  detailsCompleted: true,
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  schedulingPrefs: {},
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  db.isDbReady.mockReturnValue(false);
  Object.keys(userSessions).forEach((k) => delete userSessions[k]);
  Object.keys(aiService.pendingContext).forEach((k) => delete aiService.pendingContext[k]);
  User.findOne.mockImplementation(async ({ phone, instructorId }) => learner(phone, instructorId));
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
});

function webhookBody(messages, phoneNumberId = "inst-A") {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, messages } }] }],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("1.1 concurrent messages", () => {
  it("each reply goes out with its own instructor's account", async () => {
    jest.spyOn(aiService, "getResponse").mockImplementation(async (text) => {
      await sleep(text.includes("slow") ? 60 : 5);
      return `reply to ${text}\n[ACTION:NULL]\n{}`;
    });

    await Promise.all([
      webhookController.handleIncomingMessage("4471", "slow hello", "inst-A"),
      webhookController.handleIncomingMessage("4472", "quick hello", "inst-B"),
    ]);

    const calls = whatsappService.sendTextMessage.mock.calls;
    const toA = calls.find(([to]) => to === "4471");
    const toB = calls.find(([to]) => to === "4472");
    expect(toA[1]).toBe("reply to slow hello");
    expect(toA[2].phoneNumberId).toBe("inst-A");
    expect(toB[1]).toBe("reply to quick hello");
    expect(toB[2].phoneNumberId).toBe("inst-B");
  });

  it("mock replies land in the right mock chat", async () => {
    jest.spyOn(aiService, "getResponse").mockImplementation(async (text) => {
      await sleep(text === "first" ? 40 : 1);
      return `${text}!\n[ACTION:NULL]\n{}`;
    });
    const a = [];
    const b = [];
    await Promise.all([
      webhookController.handleIncomingMessage("4471", "first", "inst-A", true, (r) => a.push(r)),
      webhookController.handleIncomingMessage("4472", "second", "inst-B", true, (r) => b.push(r)),
    ]);
    expect(a).toEqual(["first!"]);
    expect(b).toEqual(["second!"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("1.2 booking ownership and ids", () => {
  it("a learner can't cancel someone else's booking", async () => {
    Booking.findOne.mockResolvedValue(null); // scoped lookup finds nothing
    jest.spyOn(aiService, "getResponse").mockResolvedValue(
      'Cancelling.\n[ACTION:CANCEL_BOOKING]\n{"bookingId": "DL-AAAAAA"}'
    );
    const replies = [];

    await webhookController.handleIncomingMessage("447B", "cancel DL-AAAAAA", "inst-A", true, (r) => replies.push(r));

    expect(Booking.findOne).toHaveBeenCalledWith({ bookingId: "DL-AAAAAA", userPhone: "447B", instructorId: "inst-A" });
    expect(replies[1]).toContain("No booking found with ID DL-AAAAAA");
    expect(calendarService.deleteEvent).not.toHaveBeenCalled();
  });

  it("cancelBooking with a scope only matches the learner's own booking", async () => {
    Booking.findOne.mockResolvedValue(null);
    expect(await bookingService.cancelBooking("DL-AAAAAA", { userPhone: "447B", instructorId: "inst-A" })).toBeNull();
    expect(Booking.findOne).toHaveBeenCalledWith({ bookingId: "DL-AAAAAA", userPhone: "447B", instructorId: "inst-A" });
  });

  it("a learner can't reschedule someone else's booking", async () => {
    Booking.findOne.mockResolvedValue(null);
    const result = await bookingService.rescheduleBooking(
      "447B", { bookingId: "DL-AAAAAA", newDate: "2030-07-02", newTime: "10:00" }, "inst-A"
    );
    expect(result).toBeNull();
    expect(Booking.findOne).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "DL-AAAAAA", userPhone: "447B", instructorId: "inst-A" }));
    expect(calendarService.updateEvent).not.toHaveBeenCalled();
  });

  it("new bookings get 6-character ids and retry on a clash", async () => {
    const ids = [];
    Booking.create.mockImplementation(async (doc) => {
      ids.push(doc.bookingId);
      if (ids.length === 1) throw Object.assign(new Error("dup"), { code: 11000, keyPattern: { bookingId: 1 } });
      return { ...doc, _id: "b1" };
    });
    calendarService.createEvent.mockResolvedValue({ id: "evt-1" });

    const { booking } = await bookingService.createBooking(
      "4471", { date: "2030-07-01", time: "10:00", userPhone: "4471" }, mockInstructors["inst-A"]
    );

    expect(ids).toHaveLength(2);
    ids.forEach((id) => expect(id).toMatch(/^DL-[A-HJ-NP-Z2-9]{6}$/));
    expect(booking.bookingId).toBe(ids[1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("1.3 webhook acknowledgement and repeats", () => {
  it("answers 200 before the AI has finished", async () => {
    let finishAi;
    jest.spyOn(aiService, "getResponse").mockReturnValue(new Promise((r) => (finishAi = r)));
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    const pending = webhookController.handleWebhook(
      { body: webhookBody([{ from: "4471", id: "wamid.1", type: "text", text: { body: "can you help me with a lesson?" } }]) },
      res
    );
    await sleep(10);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalled();
    finishAi("hello\n[ACTION:NULL]\n{}");
    await pending;
    expect(whatsappService.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("handles a repeated message id only once", async () => {
    db.isDbReady.mockReturnValue(true);
    ConversationSession.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    ConversationSession.updateOne.mockResolvedValue({});
    const seen = new Set();
    ProcessedMessage.create.mockImplementation(async ({ _id }) => {
      if (seen.has(_id)) throw Object.assign(new Error("dup"), { code: 11000 });
      seen.add(_id);
    });
    jest.spyOn(aiService, "getResponse").mockResolvedValue("Booked!\n[ACTION:NULL]\n{}");
    const res = () => ({ status: jest.fn().mockReturnThis(), send: jest.fn() });
    const body = webhookBody([{ from: "4471", id: "wamid.SAME", type: "text", text: { body: "yes book it" } }]);

    await webhookController.handleWebhook({ body }, res());
    await webhookController.handleWebhook({ body }, res());

    expect(aiService.getResponse).toHaveBeenCalledTimes(1);
    expect(whatsappService.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores status-only updates", async () => {
    const spy = jest.spyOn(aiService, "getResponse");
    const body = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "inst-A" }, statuses: [{ status: "read" }] } }] }],
    };
    await webhookController.handleWebhook({ body }, { status: jest.fn().mockReturnThis(), send: jest.fn() });
    expect(spy).not.toHaveBeenCalled();
  });

  it("marks real messages as read with a typing indicator", async () => {
    jest.spyOn(aiService, "getResponse").mockResolvedValue("hi\n[ACTION:NULL]\n{}");
    await webhookController.handleWebhook(
      { body: webhookBody([{ from: "4471", id: "wamid.T", type: "text", text: { body: "can you help me with a lesson?" } }]) },
      { status: jest.fn().mockReturnThis(), send: jest.fn() }
    );
    expect(whatsappService.markReadAndTyping).toHaveBeenCalledWith("wamid.T", mockInstructors["inst-A"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("1.4 one booking per slot", () => {
  it("two learners racing for a slot: one booked, one told it's taken, one calendar event", async () => {
    let claimed = false;
    Booking.create.mockImplementation(async (doc) => {
      await sleep(5);
      if (claimed) throw Object.assign(new Error("dup"), { code: 11000, keyPattern: { instructorId: 1, date: 1, time: 1 } });
      claimed = true;
      return { ...doc, _id: "b1" };
    });
    calendarService.createEvent.mockResolvedValue({ id: "evt-1" });
    const data = (phone) => ({ date: "2030-07-01", time: "10:00", userPhone: phone });

    const results = await Promise.allSettled([
      bookingService.createBooking("4471", data("4471"), mockInstructors["inst-A"]),
      bookingService.createBooking("4472", data("4472"), mockInstructors["inst-A"]),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ code: "SLOT_TAKEN", userFacing: true });
    expect(failed[0].reason.message).toContain("was just booked by someone else");
    expect(calendarService.createEvent).toHaveBeenCalledTimes(1);
  });

  it("claims the slot before creating the calendar event, and releases it if the calendar fails", async () => {
    const order = [];
    Booking.create.mockImplementation(async (doc) => {
      order.push("db");
      return { ...doc, _id: "b1" };
    });
    calendarService.createEvent.mockImplementation(async () => {
      order.push("calendar");
      throw new Error("calendar down");
    });

    await expect(
      bookingService.createBooking("4471", { date: "2030-07-01", time: "10:00", userPhone: "4471" }, mockInstructors["inst-A"])
    ).rejects.toThrow("calendar down");

    expect(order).toEqual(["db", "calendar"]);
    expect(Booking.deleteOne).toHaveBeenCalledWith({ _id: "b1" });
  });

  it("stores the calendar event id once the event exists", async () => {
    Booking.create.mockImplementation(async (doc) => ({ ...doc, _id: "b1" }));
    calendarService.createEvent.mockResolvedValue({ id: "evt-9" });
    const { booking } = await bookingService.createBooking(
      "4471", { date: "2030-07-01", time: "10:00", userPhone: "4471" }, mockInstructors["inst-A"]
    );
    expect(Booking.create).toHaveBeenCalledWith(expect.objectContaining({ calendarEventId: null }));
    expect(Booking.updateOne).toHaveBeenCalledWith({ _id: "b1" }, { calendarEventId: "evt-9" });
    expect(booking.calendarEventId).toBe("evt-9");
  });

  it("reschedule into a taken slot is refused and the calendar isn't touched", async () => {
    const doc = {
      bookingId: "DL-MOVE01", userPhone: "4471", instructorId: "inst-A", date: "2030-07-01", time: "09:00",
      status: "confirmed", calendarEventId: "evt-1",
      toObject() { return { ...this }; },
      save: jest.fn().mockRejectedValue(Object.assign(new Error("dup"), { code: 11000, keyPattern: { instructorId: 1, date: 1, time: 1 } })),
    };
    Booking.findOne.mockResolvedValue(doc);

    await expect(
      bookingService.rescheduleBooking("4471", { bookingId: "DL-MOVE01", newDate: "2030-07-02", newTime: "10:00" }, "inst-A")
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    expect(calendarService.updateEvent).not.toHaveBeenCalled();
  });

  it("undoes a reschedule if the calendar update fails", async () => {
    const doc = {
      bookingId: "DL-MOVE02", userPhone: "4471", instructorId: "inst-A", date: "2030-07-01", time: "09:00",
      status: "confirmed", calendarEventId: "evt-1",
      toObject() { return { ...this }; },
      save: jest.fn().mockResolvedValue(),
    };
    Booking.findOne.mockResolvedValue(doc);
    calendarService.updateEvent.mockRejectedValue(new Error("calendar down"));

    await expect(
      bookingService.rescheduleBooking("4471", { bookingId: "DL-MOVE02", newDate: "2030-07-02", newTime: "10:00" }, "inst-A")
    ).rejects.toThrow("calendar down");
    expect(doc).toMatchObject({ date: "2030-07-01", time: "09:00", status: "confirmed" });
    expect(doc.save).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("1.5 persisted conversations", () => {
  beforeEach(() => db.isDbReady.mockReturnValue(true));

  it("a conversation survives a restart", async () => {
    let stored = null;
    ConversationSession.updateOne.mockImplementation(async (_q, { $set }) => {
      stored = { ...$set };
    });
    ConversationSession.findOne.mockImplementation(() => ({ lean: () => Promise.resolve(stored) }));

    userSessions["4471::inst-A"] = { conversationHistory: [{ role: "user", content: "Tuesday?" }] };
    aiService.pendingContext["4471"] = { date: "2030-07-01", pickupAddress: "ST5 1AB", _updatedAt: Date.now() };
    await sessionStore.save("4471", "inst-A");
    expect(stored.pending).toEqual({ date: "2030-07-01", pickupAddress: "ST5 1AB" });

    // "Restart": in-memory state is gone
    delete userSessions["4471::inst-A"];
    delete aiService.pendingContext["4471"];

    await sessionStore.load("4471", "inst-A");
    expect(userSessions["4471::inst-A"].conversationHistory).toEqual([{ role: "user", content: "Tuesday?" }]);
    expect(aiService.pendingContext["4471"]).toMatchObject({ date: "2030-07-01", pickupAddress: "ST5 1AB" });
  });

  it("an expired session starts fresh", async () => {
    ConversationSession.findOne.mockReturnValue({
      lean: () => Promise.resolve({
        conversationHistory: [{ role: "user", content: "old" }],
        pending: { date: "2030-07-01" },
        lastActivity: new Date(Date.now() - 2 * 60 * 60 * 1000),
      }),
    });
    aiService.pendingContext["4471"] = { date: "stale" };

    await sessionStore.load("4471", "inst-A");

    expect(userSessions["4471::inst-A"].conversationHistory).toEqual([]);
    expect(aiService.pendingContext["4471"]).toBeUndefined();
  });

  it("each message loads the session before the AI runs and saves it after", async () => {
    const order = [];
    ConversationSession.findOne.mockImplementation(() => {
      order.push("load");
      return { lean: () => Promise.resolve(null) };
    });
    ConversationSession.updateOne.mockImplementation(async () => order.push("save"));
    ProcessedMessage.create.mockResolvedValue({});
    jest.spyOn(aiService, "getResponse").mockImplementation(async () => {
      order.push("ai");
      return "ok\n[ACTION:NULL]\n{}";
    });

    await webhookController.handleIncomingMessage("4471", "can you help me with a lesson?", "inst-A", true, () => {});

    expect(order).toEqual(["load", "ai", "save"]);
  });

  it("two quick messages from one learner are handled in order", async () => {
    db.isDbReady.mockReturnValue(false);
    const seen = [];
    jest.spyOn(aiService, "getResponse").mockImplementation(async (text) => {
      seen.push(`start ${text}`);
      await sleep(text === "one" ? 30 : 1);
      seen.push(`end ${text}`);
      return `${text}\n[ACTION:NULL]\n{}`;
    });

    await Promise.all([
      webhookController.handleIncomingMessage("4471", "one", "inst-A", true, () => {}),
      webhookController.handleIncomingMessage("4471", "two", "inst-A", true, () => {}),
    ]);

    expect(seen).toEqual(["start one", "end one", "start two", "end two"]);
  });

  it("different learners don't wait for each other", async () => {
    const seen = [];
    await Promise.all([
      runExclusive("a", async () => { seen.push("a1"); await sleep(20); seen.push("a2"); }),
      runExclusive("b", async () => { seen.push("b1"); seen.push("b2"); }),
    ]);
    expect(seen.indexOf("b2")).toBeLessThan(seen.indexOf("a2"));
  });

  it("a failed task doesn't block the learner's next message", async () => {
    await runExclusive("c", async () => { throw new Error("boom"); }).catch(() => {});
    await expect(runExclusive("c", async () => "next")).resolves.toBe("next");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("1.4 portal bookings use the same slot lock", () => {
  const express = require("express");
  let server;
  let url;

  beforeAll((done) => {
    const router = require("../../src/routes/learners");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.instructor = mockInstructors["inst-A"];
      next();
    });
    app.use("/api/learners", router);
    server = app.listen(0, () => {
      url = `http://127.0.0.1:${server.address().port}/api/learners/bookings`;
      done();
    });
  });
  afterAll((done) => {
    server.close(() => done());
  });

  const post = (body) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(() => {
    User.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ name: "Jane" }) }) });
    // No other lessons that day, so there's nothing to overlap
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  it("creates the booking before the calendar event", async () => {
    const order = [];
    Booking.create.mockImplementation(async (doc) => { order.push("db"); return { ...doc, _id: "b1" }; });
    calendarService.createEvent.mockImplementation(async () => { order.push("calendar"); return { id: "evt-5" }; });

    const res = await post({ userPhone: "4471", date: "2030-07-01", time: "10:00" });

    expect(res.status).toBe(201);
    expect(order).toEqual(["db", "calendar"]);
    expect(res.body.data.bookingId).toMatch(/^DL-[A-Z2-9]{6}$/);
    expect(res.body.data.calendarEventId).toBe("evt-5");
  });

  it("returns 409 when the slot is already booked, without a calendar event", async () => {
    Booking.create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000, keyPattern: { instructorId: 1, date: 1, time: 1 } }));

    const res = await post({ userPhone: "4471", date: "2030-07-01", time: "10:00" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("10:00 on 2030-07-01 is already booked");
    expect(calendarService.createEvent).not.toHaveBeenCalled();
  });
});
