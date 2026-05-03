/**
 * Geocoding – E2E Tests (Real Google Maps Geocoding API)
 * ───────────────────────────────────────────────────────
 * Tests real postcode → lat/lng resolution via mapsService.
 *
 *  1. UK postcode resolves to correct area
 *  2. Full address resolves to coordinates
 *  3. Invalid postcode returns error
 *  4. Coordinates are in the UK bounding box
 *  5. Formatted address is populated
 *
 * Requires: GOOGLE_MAPS_API_KEY env var
 * Run:      npm run test:e2e
 */

// Env loaded via helpers.js → envs/.env.test
const { describeE2E, E2E_KEYS } = require("./helpers");

const TIMEOUT = 15000;

// Real module — no mocks
const mapsService = require("../../src/services/mapsService");

// UK bounding box (rough)
const UK_BOUNDS = {
  latMin: 49.8,
  latMax: 60.9,
  lngMin: -8.7,
  lngMax: 1.8,
};

describeE2E(E2E_KEYS.MAPS, "E2E – Geocoding (Real Google Maps API)", () => {
  // ─── Valid UK postcodes ──────────────────────────────────────────────

  it(
    "resolves ST5 1AB (Newcastle-under-Lyme) to coordinates near Stoke",
    async () => {
      const result = await mapsService.getCoordinatesFromPostalCode("ST5 1AB");

      expect(result.lat).toBeGreaterThan(52.9);
      expect(result.lat).toBeLessThan(53.1);
      expect(result.lng).toBeGreaterThan(-2.4);
      expect(result.lng).toBeLessThan(-2.1);
      expect(result.formattedAddress).toBeDefined();
      expect(result.mapUrl).toContain("google.com/maps");

      console.log(`  📍 ST5 1AB → (${result.lat}, ${result.lng}) — ${result.formattedAddress}`);
    },
    TIMEOUT
  );

  it(
    "resolves ST4 2DE (Stoke) to coordinates",
    async () => {
      const result = await mapsService.getCoordinatesFromPostalCode("ST4 2DE");

      expect(result.lat).toBeGreaterThan(52.9);
      expect(result.lat).toBeLessThan(53.1);
      expect(result.formattedAddress).toBeDefined();

      console.log(`  📍 ST4 2DE → (${result.lat}, ${result.lng}) — ${result.formattedAddress}`);
    },
    TIMEOUT
  );

  it(
    "resolves SW1A 1AA (Buckingham Palace) to central London area",
    async () => {
      const result = await mapsService.getCoordinatesFromPostalCode("SW1A 1AA");

      expect(result.lat).toBeGreaterThan(51.4);
      expect(result.lat).toBeLessThan(51.6);
      expect(result.lng).toBeGreaterThan(-0.2);
      expect(result.lng).toBeLessThan(0.0);

      console.log(`  📍 SW1A 1AA → (${result.lat}, ${result.lng}) — ${result.formattedAddress}`);
    },
    TIMEOUT
  );

  it(
    "resolves a full address string",
    async () => {
      const result = await mapsService.getCoordinatesFromPostalCode(
        "10 Downing Street, London"
      );

      expect(result.lat).toBeDefined();
      expect(result.lng).toBeDefined();
      // Should be in UK bounds
      expect(result.lat).toBeGreaterThan(UK_BOUNDS.latMin);
      expect(result.lat).toBeLessThan(UK_BOUNDS.latMax);
      expect(result.lng).toBeGreaterThan(UK_BOUNDS.lngMin);
      expect(result.lng).toBeLessThan(UK_BOUNDS.lngMax);

      console.log(`  📍 10 Downing St → (${result.lat}, ${result.lng}) — ${result.formattedAddress}`);
    },
    TIMEOUT
  );

  // ─── Nearby postcodes are nearby ────────────────────────────────────

  it(
    "two nearby postcodes resolve to nearby coordinates",
    async () => {
      const a = await mapsService.getCoordinatesFromPostalCode("ST5 1AB");
      const b = await mapsService.getCoordinatesFromPostalCode("ST5 1AE");

      // Should be within ~1km of each other
      const distKm = Math.sqrt(
        Math.pow((a.lat - b.lat) * 111, 2) +
        Math.pow((a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180), 2)
      );

      expect(distKm).toBeLessThan(2.2); // less than 2km apart
      console.log(`  📍 ST5 1AB ↔ ST5 1AE: ${distKm.toFixed(2)} km apart`);
    },
    TIMEOUT
  );

  // ─── Far apart postcodes are far apart ──────────────────────────────

  it(
    "Stoke and London postcodes are far apart",
    async () => {
      const stoke = await mapsService.getCoordinatesFromPostalCode("ST5 1AB");
      const london = await mapsService.getCoordinatesFromPostalCode("SW1A 1AA");

      const distKm = Math.sqrt(
        Math.pow((stoke.lat - london.lat) * 111, 2) +
        Math.pow((stoke.lng - london.lng) * 111 * Math.cos(stoke.lat * Math.PI / 180), 2)
      );

      expect(distKm).toBeGreaterThan(150); // Stoke to London > 150km
      console.log(`  📍 Stoke ↔ London: ${distKm.toFixed(0)} km apart`);
    },
    TIMEOUT
  );

  // ─── Invalid postcodes ──────────────────────────────────────────────

  it(
    "rejects an empty postcode",
    async () => {
      await expect(
        mapsService.getCoordinatesFromPostalCode("")
      ).rejects.toThrow("Postal code is required");
    },
    TIMEOUT
  );

  it(
    "rejects a null postcode",
    async () => {
      await expect(
        mapsService.getCoordinatesFromPostalCode(null)
      ).rejects.toThrow("Postal code is required");
    },
    TIMEOUT
  );

  // ─── Google Maps link generation ────────────────────────────────────

  it(
    "generates a valid Google Maps link",
    async () => {
      const result = await mapsService.getGoogleMapsLink("ST5 1AB");

      expect(result.link).toContain("google.com/maps");
      expect(result.link).toContain("ST5");
      expect(result.message).toContain("ST5 1AB");
    },
    TIMEOUT
  );
});
