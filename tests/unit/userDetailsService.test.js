/**
 * UserDetailsService – Unit Tests
 * ─────────────────────────────────
 * Covers the ensureUserDetails function:
 *
 *  1. New user → starts signup flow, asks for name
 *  2. Multi-step signup (name → age → dob → postalCode)
 *  3. Final step geocoding success/failure
 *  4. Returning user with completed details → passes through
 *  5. Data deletion ("delete my data")
 *  6. Edge cases
 */

jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn(),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn(),
}));

const User = require("../../src/models/userModel");
const mapsService = require("../../src/services/mapsService");
const { ensureUserDetails } = require("../../src/services/userDetailsService");

// Mock the User model
jest.mock("../../src/models/userModel");

let sendFn;

beforeEach(() => {
  jest.clearAllMocks();
  sendFn = jest.fn();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. New user → start signup
// ═══════════════════════════════════════════════════════════════════════════

describe("New user signup", () => {
  it("creates a new user and asks for name", async () => {
    User.findOne.mockResolvedValue(null);
    const mockSave = jest.fn();
    User.mockImplementation((data) => ({
      ...data,
      save: mockSave,
    }));

    const result = await ensureUserDetails("447000000001", "Hello", sendFn, "inst-1");

    expect(result.inProgress).toBe(true);
    expect(User).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "447000000001",
        instructorId: "inst-1",
        currentStep: "name",
      })
    );
    expect(mockSave).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledWith("447000000001", expect.stringContaining("name"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Multi-step signup progression
// ═══════════════════════════════════════════════════════════════════════════

describe("Signup step progression", () => {
  it("saves name and asks for age", async () => {
    const mockUser = {
      phone: "447000000001",
      currentStep: "name",
      detailsCompleted: false,
      save: jest.fn(),
    };
    User.findOne.mockResolvedValue(mockUser);

    const result = await ensureUserDetails("447000000001", "Raj", sendFn);

    expect(mockUser.name).toBe("Raj");
    expect(mockUser.currentStep).toBe("age");
    expect(mockUser.save).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledWith("447000000001", expect.stringContaining("age"));
    expect(result.inProgress).toBe(true);
  });

  it("saves age and asks for dob", async () => {
    const mockUser = {
      phone: "447000000001",
      currentStep: "age",
      detailsCompleted: false,
      save: jest.fn(),
    };
    User.findOne.mockResolvedValue(mockUser);

    const result = await ensureUserDetails("447000000001", "25", sendFn);

    expect(mockUser.age).toBe("25");
    expect(mockUser.currentStep).toBe("dob");
    expect(result.inProgress).toBe(true);
  });

  it("saves dob and asks for postalCode", async () => {
    const mockUser = {
      phone: "447000000001",
      currentStep: "dob",
      detailsCompleted: false,
      save: jest.fn(),
    };
    User.findOne.mockResolvedValue(mockUser);

    const result = await ensureUserDetails("447000000001", "01/01/2000", sendFn);

    expect(mockUser.dob).toBe("01/01/2000");
    expect(mockUser.currentStep).toBe("postalCode");
    expect(result.inProgress).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Final step – postalCode with geocoding
// ═══════════════════════════════════════════════════════════════════════════

describe("Final step – postalCode + geocoding", () => {
  it("completes signup with successful geocoding", async () => {
    const mockUser = {
      phone: "447000000001",
      currentStep: "postalCode",
      detailsCompleted: false,
      save: jest.fn(),
    };
    User.findOne.mockResolvedValue(mockUser);

    mapsService.getCoordinatesFromPostalCode.mockResolvedValue({
      lat: 53.0168,
      lng: -2.2191,
      message: "📍 Location Found! Stoke-on-Trent",
    });

    const result = await ensureUserDetails("447000000001", "ST5 1AB", sendFn);

    expect(mockUser.postalCode).toBe("ST5 1AB");
    expect(mockUser.detailsCompleted).toBe(true);
    expect(mockUser.currentStep).toBeNull();
    expect(mockUser.location).toEqual({ latitude: 53.0168, longitude: -2.2191 });
    expect(mockUser.save).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledWith("447000000001", expect.stringContaining("Location Found"));
    expect(sendFn).toHaveBeenCalledWith("447000000001", expect.stringContaining("details are saved"));
    expect(result.inProgress).toBe(false);
    expect(result.justCompleted).toBe(true);
  });

  it("completes signup even when geocoding fails", async () => {
    const mockUser = {
      phone: "447000000001",
      currentStep: "postalCode",
      detailsCompleted: false,
      save: jest.fn(),
    };
    User.findOne.mockResolvedValue(mockUser);

    mapsService.getCoordinatesFromPostalCode.mockRejectedValue(
      new Error("Geocoding failed: ZERO_RESULTS")
    );

    const result = await ensureUserDetails("447000000001", "INVALID", sendFn);

    expect(mockUser.detailsCompleted).toBe(true);
    expect(sendFn).toHaveBeenCalledWith(
      "447000000001",
      expect.stringContaining("Couldn't fetch your location")
    );
    expect(sendFn).toHaveBeenCalledWith("447000000001", expect.stringContaining("details are saved"));
    expect(result.inProgress).toBe(false);
    expect(result.justCompleted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Returning user with completed details
// ═══════════════════════════════════════════════════════════════════════════

describe("Returning user", () => {
  it("passes through when details are already completed", async () => {
    const mockUser = {
      phone: "447000000001",
      detailsCompleted: true,
      name: "Raj",
    };
    User.findOne.mockResolvedValue(mockUser);

    const result = await ensureUserDetails("447000000001", "Book a lesson", sendFn);

    expect(result.inProgress).toBe(false);
    expect(result.user).toBeDefined();
    expect(result.user.name).toBe("Raj");
    expect(sendFn).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Data deletion
// ═══════════════════════════════════════════════════════════════════════════

describe("Data deletion", () => {
  it("deletes user data on 'delete my data' command", async () => {
    User.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const result = await ensureUserDetails("447000000001", "delete my data", sendFn);

    expect(User.deleteOne).toHaveBeenCalledWith({ phone: "447000000001" });
    expect(sendFn).toHaveBeenCalledWith("447000000001", expect.stringContaining("deleted"));
    expect(result.inProgress).toBe(true);
    expect(result.deleted).toBe(true);
  });

  it("handles 'DELETE MY DATA' (case insensitive)", async () => {
    User.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const result = await ensureUserDetails("447000000001", "DELETE MY DATA", sendFn);

    expect(User.deleteOne).toHaveBeenCalledWith({ phone: "447000000001" });
    expect(result.deleted).toBe(true);
  });

  it("handles '  delete my data  ' (with whitespace)", async () => {
    User.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const result = await ensureUserDetails("447000000001", "  delete my data  ", sendFn);

    expect(User.deleteOne).toHaveBeenCalledWith({ phone: "447000000001" });
    expect(result.deleted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge cases", () => {
  it("trims whitespace from user input", async () => {
    const mockUser = {
      phone: "447000000001",
      currentStep: "name",
      detailsCompleted: false,
      save: jest.fn(),
    };
    User.findOne.mockResolvedValue(mockUser);

    await ensureUserDetails("447000000001", "  Raj  ", sendFn);

    expect(mockUser.name).toBe("Raj");
  });

  it("asks next question when currentStep is set", async () => {
    const mockUser = {
      phone: "447000000001",
      currentStep: "age",
      detailsCompleted: false,
      save: jest.fn(),
    };
    User.findOne.mockResolvedValue(mockUser);

    // Send a step name as message — should NOT overwrite (guarded by condition)
    await ensureUserDetails("447000000001", "age", sendFn);

    expect(sendFn).toHaveBeenCalledWith("447000000001", expect.stringContaining("age"));
  });
});
