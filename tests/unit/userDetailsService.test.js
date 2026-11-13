/**
 * Learner WhatsApp sign-up (ensureUserDetails): name → age → postcode,
 * with each answer checked before it's saved.
 */

jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/services/whatsappService", () => ({ sendTextMessage: jest.fn() }));
jest.mock("../../src/services/mapsService", () => ({ getCoordinatesFromPostalCode: jest.fn() }));
jest.mock("../../src/models/userModel");

const User = require("../../src/models/userModel");
const mapsService = require("../../src/services/mapsService");
const { ensureUserDetails } = require("../../src/services/userDetailsService");
const { parseName, parseAge, parsePostcode } = require("../../src/utils/learnerDetails");

const PHONE = "447000000001";
let sendFn;

const learner = (fields) => {
  const user = { phone: PHONE, detailsCompleted: false, save: jest.fn(), ...fields };
  User.findOne.mockResolvedValue(user);
  return user;
};
const lastReply = () => sendFn.mock.calls.at(-1)[1];

beforeEach(() => {
  jest.clearAllMocks();
  sendFn = jest.fn();
});

describe("new number", () => {
  it("creates the learner and asks for their full name", async () => {
    User.findOne.mockResolvedValue(null);
    const save = jest.fn();
    User.mockImplementation((data) => ({ ...data, save }));

    const result = await ensureUserDetails(PHONE, "Hello", sendFn, "inst-1");

    expect(result.inProgress).toBe(true);
    expect(User).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE, instructorId: "inst-1", currentStep: "name" }));
    expect(save).toHaveBeenCalled();
    expect(lastReply()).toContain("*full name*");
    expect(lastReply()).toMatch(/Powered by Donna Drive · donnadrive\.co\.uk_$/);
  });

  it("uses the instructor's greeting", async () => {
    User.findOne.mockResolvedValue(null);
    User.mockImplementation((data) => ({ ...data, save: jest.fn() }));
    await ensureUserDetails(PHONE, "Hi", sendFn, "inst-1", "Hi from Sam's Driving School!");
    expect(lastReply()).toMatch(/^Hi from Sam's Driving School!/);
  });

  it("stays quiet when two first messages arrive at once", async () => {
    User.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ phone: PHONE });
    User.mockImplementation((data) => ({ ...data, save: jest.fn().mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 })) }));
    expect(await ensureUserDetails(PHONE, "Hi", sendFn, "inst-1")).toEqual({ inProgress: true });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("doesn't hide a duplicate error when no learner was actually created", async () => {
    User.findOne.mockResolvedValue(null);
    User.mockImplementation((data) => ({ ...data, save: jest.fn().mockRejectedValue(Object.assign(new Error("E11000 phone_1"), { code: 11000 })) }));
    await expect(ensureUserDetails(PHONE, "Hi", sendFn, "inst-1")).rejects.toThrow("E11000");
  });
});

describe("name", () => {
  it("saves a tidied name and asks for age", async () => {
    const user = learner({ currentStep: "name" });
    await ensureUserDetails(PHONE, "  my name is jordan smith  ", sendFn);
    expect(user.name).toBe("Jordan Smith");
    expect(user.currentStep).toBe("age");
    expect(lastReply()).toBe("Thanks, Jordan! How *old* are you?");
  });

  it.each(["Book a lesson", "hi", "12345", "https://x.com", "😀", "Can I book a lesson for tomorrow at 10am please mate"])(
    "asks again for %p",
    async (answer) => {
      const user = learner({ currentStep: "name" });
      await ensureUserDetails(PHONE, answer, sendFn);
      expect(user.name).toBeUndefined();
      expect(user.save).not.toHaveBeenCalled();
      expect(lastReply()).toContain("didn't catch your name");
    }
  );
});

describe("age", () => {
  it("saves the number and asks for postcode", async () => {
    const user = learner({ currentStep: "age", name: "Jordan" });
    await ensureUserDetails(PHONE, "I'm 18", sendFn);
    expect(user.age).toBe(18);
    expect(user.currentStep).toBe("postalCode");
    expect(lastReply()).toContain("*postcode*");
  });

  it("asks again for words or two numbers", async () => {
    const user = learner({ currentStep: "age" });
    await ensureUserDetails(PHONE, "eighteen", sendFn);
    await ensureUserDetails(PHONE, "01/01/2000", sendFn);
    expect(user.age).toBeUndefined();
    expect(lastReply()).toContain("as a number");
  });

  it("doesn't sign up anyone under 16", async () => {
    const user = learner({ currentStep: "age" });
    await ensureUserDetails(PHONE, "14", sendFn);
    expect(user.age).toBeUndefined();
    expect(user.currentStep).toBe("age");
    expect(lastReply()).toContain("You need to be 17");
  });

  it("lets 16-year-olds carry on with a note about PIP", async () => {
    const user = learner({ currentStep: "age", name: "Jordan" });
    await ensureUserDetails(PHONE, "16", sendFn);
    expect(user.age).toBe(16);
    expect(lastReply()).toMatch(/PIP[\s\S]*\*postcode\*/);
  });
});

describe("postcode", () => {
  it("tidies the postcode, saves the location and finishes", async () => {
    const user = learner({ currentStep: "postalCode", name: "Jordan Smith", age: 18 });
    mapsService.getCoordinatesFromPostalCode.mockResolvedValue({ lat: 53, lng: -2.2, formattedAddress: "Newcastle ST5 1AB, UK" });

    const result = await ensureUserDetails(PHONE, "st51ab", sendFn);

    expect(mapsService.getCoordinatesFromPostalCode).toHaveBeenCalledWith("ST5 1AB");
    expect(user.postalCode).toBe("ST5 1AB");
    expect(user.location).toEqual({ latitude: 53, longitude: -2.2 });
    expect(user.detailsCompleted).toBe(true);
    expect(user.currentStep).toBeNull();
    expect(lastReply()).toBe("✅ Thanks Jordan, you're all set!\n📍 Newcastle ST5 1AB, UK");
    expect(result).toEqual({ inProgress: false, user, justCompleted: true });
  });

  it("finds a postcode in a shared location", async () => {
    const user = learner({ currentStep: "postalCode", name: "Jordan", age: 18 });
    mapsService.getCoordinatesFromPostalCode.mockResolvedValue({ lat: 1, lng: 2 });
    await ensureUserDetails(PHONE, "📍 Shared location: 1 High St, Newcastle ST5 1AB", sendFn);
    expect(user.postalCode).toBe("ST5 1AB");
  });

  it("asks again for something that isn't a postcode", async () => {
    const user = learner({ currentStep: "postalCode", name: "Jordan", age: 18 });
    await ensureUserDetails(PHONE, "near the station", sendFn);
    expect(user.postalCode).toBeUndefined();
    expect(mapsService.getCoordinatesFromPostalCode).not.toHaveBeenCalled();
    expect(lastReply()).toContain("UK postcode");
  });

  it("asks again when Google can't find it", async () => {
    const user = learner({ currentStep: "postalCode", name: "Jordan", age: 18 });
    mapsService.getCoordinatesFromPostalCode.mockRejectedValue(new Error("Geocoding failed: ZERO_RESULTS"));
    await ensureUserDetails(PHONE, "ZZ9 9ZZ", sendFn);
    expect(user.detailsCompleted).toBe(false);
    expect(lastReply()).toContain("couldn't find *ZZ9 9ZZ*");
  });

  it("still finishes when Maps itself is down", async () => {
    const user = learner({ currentStep: "postalCode", name: "Jordan", age: 18 });
    mapsService.getCoordinatesFromPostalCode.mockRejectedValue(new Error("Geocoding failed: REQUEST_DENIED"));
    const result = await ensureUserDetails(PHONE, "ST5 1AB", sendFn);
    expect(user.postalCode).toBe("ST5 1AB");
    expect(result.justCompleted).toBe(true);
    expect(lastReply()).toBe("✅ Thanks Jordan, you're all set!");
  });
});

describe("learners part-way through or added in the Portal", () => {
  it("moves someone stuck on the old date of birth question on to postcode", async () => {
    const user = learner({ currentStep: "dob", name: "Jordan", age: 18 });
    await ensureUserDetails(PHONE, "01/01/2000", sendFn);
    expect(user.dob).toBeUndefined();
    expect(user.currentStep).toBe("postalCode");
    expect(lastReply()).toContain("*postcode*");
  });

  it("skips details the instructor already added", async () => {
    const user = learner({ currentStep: "start", postalCode: "ST5 1AB" });
    await ensureUserDetails(PHONE, "Hi", sendFn);
    expect(user.currentStep).toBe("name");

    await ensureUserDetails(PHONE, "Jordan Smith", sendFn);
    await ensureUserDetails(PHONE, "18", sendFn);
    expect(user.detailsCompleted).toBe(true);
  });

  it("lets a completed learner straight through", async () => {
    const user = learner({ detailsCompleted: true, name: "Raj" });
    expect(await ensureUserDetails(PHONE, "Book a lesson", sendFn)).toEqual({ inProgress: false, user });
    expect(sendFn).not.toHaveBeenCalled();
  });
});

describe("delete my data", () => {
  it("asks first, then deletes on YES", async () => {
    const user = learner({ detailsCompleted: true });
    await ensureUserDetails(PHONE, "  Delete my data ", sendFn);
    expect(User.deleteOne).not.toHaveBeenCalled();
    expect(user.deleteRequestedAt).toBeInstanceOf(Date);
    expect(lastReply()).toContain("Reply *YES*");

    const result = await ensureUserDetails(PHONE, "yes", sendFn);
    expect(User.deleteOne).toHaveBeenCalledWith({ phone: PHONE });
    expect(result.deleted).toBe(true);
  });

  it("keeps the data and carries on for any other reply", async () => {
    const user = learner({ detailsCompleted: true, deleteRequestedAt: new Date() });
    const result = await ensureUserDetails(PHONE, "actually no, book me in", sendFn);
    expect(User.deleteOne).not.toHaveBeenCalled();
    expect(user.deleteRequestedAt).toBeNull();
    expect(sendFn).toHaveBeenCalledWith(PHONE, "OK, I've kept your details.");
    expect(result).toEqual({ inProgress: false, user });
  });

  it("doesn't take a YES from long after the request", async () => {
    learner({ detailsCompleted: true, deleteRequestedAt: new Date(Date.now() - 60 * 60 * 1000) });
    await ensureUserDetails(PHONE, "yes", sendFn);
    expect(User.deleteOne).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();
  });
});

describe("answer checks", () => {
  it("names", () => {
    expect(parseName("Hi, I'm priya ramanathan-kaur").value).toBe("Priya Ramanathan-Kaur");
    expect(parseName("TOM O'NEILL").value).toBe("Tom O'Neill");
    expect(parseName("Ross McDonald 😊").value).toBe("Ross McDonald");
    expect(parseName("José").value).toBe("José");
    expect(parseName("ok").error).toBeDefined();
  });

  it("ages", () => {
    expect(parseAge("18 years old").value).toBe(18);
    expect(parseAge("0").error).toBe("out_of_range");
    expect(parseAge("150").error).toBe("out_of_range");
  });

  it("postcodes", () => {
    expect(parsePostcode("sw1a1aa").value).toBe("SW1A 1AA");
    expect(parsePostcode("my postcode is M1 1AE thanks").value).toBe("M1 1AE");
    expect(parsePostcode("ST5").error).toBe("format");
  });
});
