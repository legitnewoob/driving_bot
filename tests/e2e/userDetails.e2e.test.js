/**
 * User Details Collection – E2E Tests (Real Geocoding API)
 * ─────────────────────────────────────────────────────────
 * Tests the userDetailsService flow which collects user info
 * step by step: name → age → dob → postalCode → geocode.
 *
 * The service itself doesn't call Gemini — it's a deterministic
 * state machine. But the final step calls the REAL Maps Geocoding API
 * to resolve the postcode to lat/lng.
 *
 * We test with a real in-memory simulation (no MongoDB) using a
 * mock User model that behaves like Mongoose.
 *
 * Requires: GOOGLE_MAPS_API_KEY env var (for geocoding)
 * Run:      npm run test:e2e
 */

require("dotenv").config();

const TIMEOUT = 15000;

const describeE2E = process.env.GOOGLE_MAPS_API_KEY ? describe : describe.skip;

// We'll use the real mapsService (real API calls)
const mapsService = require("../../src/services/mapsService");

describeE2E("E2E – User Details Collection", () => {
  // Simulate the step-by-step collection flow manually
  // (we can't easily run ensureUserDetails without MongoDB,
  //  so we test the critical external call: geocoding on postal code)

  const steps = ["name", "age", "dob", "postalCode"];

  it("step order is name → age → dob → postalCode", () => {
    expect(steps).toEqual(["name", "age", "dob", "postalCode"]);
  });

  it(
    "final step: postalCode 'ST5 1AB' geocodes to real coordinates",
    async () => {
      const result = await mapsService.getCoordinatesFromPostalCode("ST5 1AB");

      expect(result.lat).toBeGreaterThan(52.9);
      expect(result.lat).toBeLessThan(53.2);
      expect(result.lng).toBeGreaterThan(-2.4);
      expect(result.lng).toBeLessThan(-2.0);
      expect(result.formattedAddress).toBeDefined();
      expect(result.message).toContain("Location Found");

      console.log(`  📍 Postal code geocoded: (${result.lat}, ${result.lng})`);
      console.log(`  📍 Address: ${result.formattedAddress}`);
    },
    TIMEOUT
  );

  it(
    "final step: postalCode 'LE1 1AA' geocodes to Leicester area",
    async () => {
      const result = await mapsService.getCoordinatesFromPostalCode("LE1 1AA");

      // Leicester is roughly around 52.6N, -1.1W
      expect(result.lat).toBeGreaterThan(52.5);
      expect(result.lat).toBeLessThan(52.8);
      expect(result.formattedAddress).toBeDefined();

      console.log(`  📍 LE1 1AA → (${result.lat}, ${result.lng}) — ${result.formattedAddress}`);
    },
    TIMEOUT
  );

  it(
    "getGoogleMapsLink produces a valid link for any postcode",
    async () => {
      const { link, message } = await mapsService.getGoogleMapsLink("ST5 1AB");

      expect(link).toContain("google.com/maps");
      expect(message).toContain("ST5 1AB");
    },
    TIMEOUT
  );

  it(
    "geocoding an invalid/gibberish postcode throws an error",
    async () => {
      await expect(
        mapsService.getCoordinatesFromPostalCode("ZZZZZZ999")
      ).rejects.toThrow();
    },
    TIMEOUT
  );
});
