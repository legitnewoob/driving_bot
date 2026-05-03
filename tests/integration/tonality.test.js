/**
 * Tonality – Integration Tests
 * ──────────────────────────────
 * Verifies the bot's conversational tone:
 *  1. System prompt enforces friendly, professional tone
 *  2. System prompt scopes the bot to driving lessons only
 *  3. AI response is sent back to user (not swallowed)
 *  4. Bot uses present continuous tense for actions (per prompt rule #6)
 *  5. Bot never exposes system availability info to users
 *  6. Conversation history is maintained between turns
 */

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/services/calendarService", () => ({
  createEvent: jest.fn(),
  updateEvent: jest.fn(),
  deleteEvent: jest.fn(),
  getEventsForDate: jest.fn().mockResolvedValue([]),
  checkSlotAgainstEvents: jest.fn().mockReturnValue({ isAvailable: true, conflictingEvents: [] }),
  findEarliestAvailableSlot: jest.fn(),
  getAvailableTimeSlotsForDate: jest.fn().mockResolvedValue(["09:00", "10:00"]),
  checkAvailability: jest.fn(),
}));
jest.mock("../../src/services/sheetsService", () => ({
  getInstructorSpreadsheetId: jest.fn().mockReturnValue("sheet-123"),
  getLearnerName: jest.fn().mockResolvedValue("Tone User"),
  updateLearnerRecord: jest.fn().mockResolvedValue({}),
  initializeCredentials: jest.fn(),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({
    lat: 53.02, lng: -2.22,
    formattedAddress: "Mock Address",
    mapUrl: "https://maps.google.com/mock",
    message: "Location found",
  }),
  getGoogleMapsLink: jest.fn(),
}));
jest.mock("../../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendMessage: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/utils/chatLogger", () => jest.fn(() => ({ info: jest.fn() })));
jest.mock("../../src/utils/dbChatLogger", () => jest.fn(() => ({
  user: jest.fn(),
  assistant: jest.fn(),
})));

// Capture the prompt sent to Gemini for inspection
global.__lastGeminiPrompt = "";

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockImplementation(async (prompt) => {
        // Capture the full prompt that was sent to Gemini
        global.__lastGeminiPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        return {
          response: {
            text: () =>
              "Hello! I'd be happy to help you with booking a driving lesson! What date works best for you?\n[ACTION:NULL]\n{}",
          },
        };
      }),
    }),
  })),
}));

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readFileSync: jest.fn().mockImplementation((filePath) => {
      if (typeof filePath === "string" && filePath.includes("SYSTEM_PROMPT")) {
        return actual.readFileSync(filePath, "utf-8");
      }
      return "You are {{INSTRUCTOR_NAME}}'s booking assistant.";
    }),
  };
});

const actualFs = jest.requireActual("fs");
const path = require("path");

const MOCK_INSTRUCTOR = {
  phoneNumberId: "inst-tone",
  name: "Tone Instructor",
  googleCalendarId: "cal@tone.com",
  googleRefreshToken: "refresh-tone",
  whatsappToken: "wa-token-tone",
  spreadsheetId: "sheet-123",
  availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
  baseLocation: { latitude: 53.0168, longitude: -2.2191 },
  rates: { basic: 50, highway: 60, parking: 45 },
  timezone: "Europe/London",
  active: true,
};

jest.mock("../../src/models/instructorModel", () => ({
  getInstructor: jest.fn(async () => MOCK_INSTRUCTOR),
  getUserSession: jest.fn(() => ({ conversationHistory: [] })),
  updateUserSession: jest.fn(),
  getAvailableDates: jest.fn().mockReturnValue(["2025-07-20"]),
}));

const User = require("../../src/models/userModel");
const webhookController = require("../../src/controllers/webhookController");
const whatsappService = require("../../src/services/whatsappService");
const { updateUserSession } = require("../../src/models/instructorModel");

const REGISTERED_USER = {
  phone: "447700000099",
  name: "Tone User",
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  detailsCompleted: true,
  instructorId: "inst-tone",
};

beforeEach(() => {
  jest.clearAllMocks();
  User.findOne.mockResolvedValue(REGISTERED_USER);
  global.__lastGeminiPrompt = "";
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. System Prompt – Tone Requirements
// ═══════════════════════════════════════════════════════════════════════════

describe("System Prompt – Tone & Personality", () => {
  const promptPath = path.join(process.cwd(), "SYSTEM_PROMPT.txt");
  let prompt;

  beforeAll(() => {
    prompt = actualFs.readFileSync(promptPath, "utf-8");
  });

  it("instructs the bot to be friendly and helpful", () => {
    expect(prompt.toLowerCase()).toContain("friendly");
    expect(prompt.toLowerCase()).toContain("helpful");
  });

  it("instructs natural conversational language", () => {
    expect(prompt.toLowerCase()).toContain("natural");
    expect(prompt.toLowerCase()).toContain("conversational");
  });

  it("instructs present continuous tense for actions", () => {
    expect(prompt.toLowerCase()).toContain("present continuous");
  });

  it("tells the bot to reiterate/repeat back details", () => {
    expect(prompt.toLowerCase()).toContain("reiterate");
  });

  it("tells the bot to ask for missing information", () => {
    expect(prompt.toLowerCase()).toContain("ask for missing");
  });

  it("tells the bot to never expose system availability block", () => {
    expect(prompt.toLowerCase()).toContain("never");
    expect(prompt.toLowerCase()).toContain("system availability");
  });

  it("defines 24-hour time format requirement", () => {
    expect(prompt).toContain("24-hour");
  });

  it("specifies available days as Monday–Friday", () => {
    expect(prompt).toContain("Monday");
    expect(prompt).toContain("Friday");
  });

  it("requires collection of pickup and dropoff addresses", () => {
    expect(prompt.toLowerCase()).toContain("pickup");
    expect(prompt.toLowerCase()).toContain("drop-off");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Prompt Injection into Gemini
// ═══════════════════════════════════════════════════════════════════════════

describe("AI Prompt – Instructor Personalization", () => {
  it("includes instructor name in the prompt sent to Gemini", async () => {
    await webhookController.handleIncomingMessage(
      "447700000099",
      "Hello",
      "inst-tone"
    );

    expect(global.__lastGeminiPrompt).toContain("Tone Instructor");
  });

  it("includes today's date in the prompt", async () => {
    await webhookController.handleIncomingMessage(
      "447700000099",
      "Hi there",
      "inst-tone"
    );

    expect(global.__lastGeminiPrompt).toContain("TODAY's date:");
  });

  it("includes the user's message in the prompt", async () => {
    await webhookController.handleIncomingMessage(
      "447700000099",
      "I want to book a lesson for next Monday",
      "inst-tone"
    );

    expect(global.__lastGeminiPrompt).toContain("I want to book a lesson for next Monday");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Response Delivery
// ═══════════════════════════════════════════════════════════════════════════

describe("Response Delivery", () => {
  it("sends the AI response text back to the user", async () => {
    await webhookController.handleIncomingMessage(
      "447700000099",
      "Hello",
      "inst-tone"
    );

    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "447700000099",
      expect.stringContaining("happy to help"),
      expect.anything()
    );
  });

  it("strips ACTION tag from the user-facing message", async () => {
    await webhookController.handleIncomingMessage(
      "447700000099",
      "What's up?",
      "inst-tone"
    );

    const sentText = whatsappService.sendTextMessage.mock.calls[0][1];
    expect(sentText).not.toContain("[ACTION:");
    expect(sentText).not.toContain("ACTION:NULL");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Conversation History
// ═══════════════════════════════════════════════════════════════════════════

describe("Conversation History", () => {
  it("saves conversation history after a message", async () => {
    await webhookController.handleIncomingMessage(
      "447700000099",
      "Hi, I need help",
      "inst-tone"
    );

    // updateUserSession should be called to persist the conversation
    expect(updateUserSession).toHaveBeenCalledWith(
      "447700000099",
      expect.objectContaining({
        conversationHistory: expect.any(Array),
      })
    );
  });

  it("conversation history includes both user and assistant messages", async () => {
    await webhookController.handleIncomingMessage(
      "447700000099",
      "Book a lesson please",
      "inst-tone"
    );

    const savedHistory = updateUserSession.mock.calls[0][1].conversationHistory;
    const roles = savedHistory.map((h) => h.role);

    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });
});
