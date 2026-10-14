/**
 * MapsService – Unit Tests
 * ─────────────────────────
 * Covers:
 *  1. getGoogleMapsLink – URL generation from postal code
 *  2. getCoordinatesFromPostalCode – Geocoding API call, success and error paths
 */

jest.mock("axios");
jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const axios = require("axios");
const { getGoogleMapsLink, getCoordinatesFromPostalCode } = require("../../src/services/mapsService");

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_MAPS_API_KEY = "test-api-key";
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. getGoogleMapsLink
// ═══════════════════════════════════════════════════════════════════════════

describe("getGoogleMapsLink", () => {
  it("returns a Google Maps link for a valid postal code", async () => {
    const result = await getGoogleMapsLink("ST5 1AB");

    expect(result.link).toBe("https://www.google.com/maps/search/?api=1&query=ST5%201AB");
    expect(result.message).toContain("ST5 1AB");
    expect(result.message).toContain("📍");
  });

  it("encodes special characters in postal code", async () => {
    const result = await getGoogleMapsLink("W1A 1AA");

    expect(result.link).toContain("W1A%201AA");
  });

  it("trims whitespace from postal code", async () => {
    const result = await getGoogleMapsLink("  ST5 1AB  ");

    expect(result.link).toContain("ST5%201AB");
  });

  it("throws when postal code is null", async () => {
    await expect(getGoogleMapsLink(null)).rejects.toThrow("Postal code is required");
  });

  it("throws when postal code is undefined", async () => {
    await expect(getGoogleMapsLink(undefined)).rejects.toThrow("Postal code is required");
  });

  it("throws when postal code is empty string", async () => {
    await expect(getGoogleMapsLink("")).rejects.toThrow("Postal code is required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. getCoordinatesFromPostalCode
// ═══════════════════════════════════════════════════════════════════════════

describe("getCoordinatesFromPostalCode", () => {
  it("returns coordinates for a valid postal code", async () => {
    axios.get.mockResolvedValue({
      data: {
        status: "OK",
        results: [
          {
            geometry: { location: { lat: 53.0168, lng: -2.2191 } },
            formatted_address: "Stoke-on-Trent ST5 1AB, UK",
          },
        ],
      },
    });

    const result = await getCoordinatesFromPostalCode("ST5 1AB");

    expect(result.lat).toBe(53.0168);
    expect(result.lng).toBe(-2.2191);
    expect(result.formattedAddress).toBe("Stoke-on-Trent ST5 1AB, UK");
    expect(result.mapUrl).toContain("53.0168");
    expect(result.mapUrl).toContain("-2.2191");
    expect(result.message).toContain("Location Found");
  });

  it("calls the Geocoding API with correct URL", async () => {
    axios.get.mockResolvedValue({
      data: {
        status: "OK",
        results: [
          {
            geometry: { location: { lat: 51.5, lng: -0.1 } },
            formatted_address: "London, UK",
          },
        ],
      },
    });

    await getCoordinatesFromPostalCode("EC1A 1BB");

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("maps.googleapis.com/maps/api/geocode/json")
    );
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("EC1A%201BB")
    );
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("key=test-api-key")
    );
  });

  it("throws when geocoding returns ZERO_RESULTS", async () => {
    axios.get.mockResolvedValue({
      data: { status: "ZERO_RESULTS", results: [] },
    });

    await expect(getCoordinatesFromPostalCode("INVALID")).rejects.toThrow(
      "Geocoding failed: ZERO_RESULTS"
    );
  });

  it("throws when geocoding returns REQUEST_DENIED", async () => {
    axios.get.mockResolvedValue({
      data: { status: "REQUEST_DENIED", results: [] },
    });

    await expect(getCoordinatesFromPostalCode("ST5 1AB")).rejects.toThrow(
      "Geocoding failed: REQUEST_DENIED"
    );
  });

  it("throws when postal code is null", async () => {
    await expect(getCoordinatesFromPostalCode(null)).rejects.toThrow(
      "Postal code is required"
    );
  });

  it("throws when postal code is empty", async () => {
    await expect(getCoordinatesFromPostalCode("")).rejects.toThrow(
      "Postal code is required"
    );
  });

  it("propagates network errors", async () => {
    axios.get.mockRejectedValue(new Error("Network Error"));

    await expect(getCoordinatesFromPostalCode("ST5 1AB")).rejects.toThrow("Network Error");
  });
});
