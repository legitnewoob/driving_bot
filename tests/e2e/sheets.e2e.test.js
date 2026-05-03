/**
 * Sheets Service – E2E Tests (Real Google Sheets API)
 * ────────────────────────────────────────────────────
 * Tests the REAL Google Sheets API through sheetsService:
 *   - Create new learner record in a real test spreadsheet
 *   - Find learner row by phone number
 *   - Update learner record (reschedule, cancel, complete)
 *   - Build row data helpers
 *
 * Requires in envs/.env.test:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL,
 *   GOOGLE_REFRESH_TOKEN (test account), GOOGLE_SPREADSHEET_ID (test sheet)
 *
 * IMPORTANT: Use a DEDICATED test spreadsheet — these tests write real data.
 *
 * Run: npm run test:e2e
 */

// Load env before anything else
const { TEST_INSTRUCTOR, connectTestDB, disconnectTestDB, cleanupTestDB, describeE2E, E2E_KEYS } = require("./helpers");

const TIMEOUT = 15000;

// Real sheetsService — no mocks
const sheetsService = require("../../src/services/sheetsService");

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const TEST_LEARNER_PHONE = "447700900099";

describeE2E(E2E_KEYS.SHEETS, "E2E – Sheets Service (Real Google Sheets API)", () => {
  beforeAll(async () => { await connectTestDB(); }, 30000);
  afterAll(async () => {
    await cleanupTestDB();
    await disconnectTestDB();
  });

  // ─── Initialize Credentials ────────────────────────────────────────

  it(
    "initializeCredentials does not throw with real refresh token",
    () => {
      expect(() => {
        sheetsService.initializeCredentials(TEST_INSTRUCTOR.googleRefreshToken);
      }).not.toThrow();
    }
  );

  // ─── Create New Learner Record ─────────────────────────────────────

  it(
    "updateLearnerRecord creates a new row for a new learner",
    async () => {
      const learnerData = {
        phoneNumber: TEST_LEARNER_PHONE,
        name: "E2E Test Learner",
        location: "ST5 1AB",
      };

      const bookingData = {
        date: "2026-06-15",
        time: "10:00",
        pickupAddress: "ST5 1AB",
        dropoffAddress: "ST4 2DE",
      };

      const result = await sheetsService.updateLearnerRecord(
        SPREADSHEET_ID,
        learnerData,
        bookingData,
        "create",
        TEST_INSTRUCTOR
      );

      expect(result).toBeDefined();
      // Google Sheets API returns updatedCells, updatedRows, etc.
      expect(result.updatedRows).toBeGreaterThanOrEqual(1);

      console.log(`  📊 Created learner row for ${TEST_LEARNER_PHONE}`);
    },
    TIMEOUT
  );

  // ─── Find Learner Row ──────────────────────────────────────────────

  it(
    "findLearnerRow finds the row we just created",
    async () => {
      const row = await sheetsService.findLearnerRow(
        SPREADSHEET_ID,
        TEST_LEARNER_PHONE,
        TEST_INSTRUCTOR
      );

      expect(row.exists).toBe(true);
      expect(row.rowIndex).toBeGreaterThan(1); // not the header row
      expect(row.data).toBeDefined();
      expect(row.data[1]).toBe(TEST_LEARNER_PHONE); // phone in column B

      console.log(`  📊 Found learner at row ${row.rowIndex}: [${row.data.join(", ")}]`);
    },
    TIMEOUT
  );

  it(
    "findLearnerRow returns exists=false for unknown phone",
    async () => {
      const row = await sheetsService.findLearnerRow(
        SPREADSHEET_ID,
        "000000000000",
        TEST_INSTRUCTOR
      );

      expect(row.exists).toBe(false);
      expect(row.nextEmptyRow).toBeDefined();
    },
    TIMEOUT
  );

  // ─── Update Learner Record (Reschedule) ────────────────────────────

  it(
    "updateLearnerRecord updates existing row on reschedule",
    async () => {
      const learnerData = {
        phoneNumber: TEST_LEARNER_PHONE,
        name: "E2E Test Learner",
        location: "ST5 1AB",
      };

      const bookingData = {
        date: "2026-06-20",
        time: "14:00",
        pickupAddress: "ST5 1AB",
        dropoffAddress: "ST4 7PX",
      };

      const result = await sheetsService.updateLearnerRecord(
        SPREADSHEET_ID,
        learnerData,
        bookingData,
        "reschedule",
        TEST_INSTRUCTOR
      );

      expect(result).toBeDefined();
      expect(result.updatedRows).toBeGreaterThanOrEqual(1);

      // Verify the row was updated
      const row = await sheetsService.findLearnerRow(
        SPREADSHEET_ID,
        TEST_LEARNER_PHONE,
        TEST_INSTRUCTOR
      );
      expect(row.exists).toBe(true);
      // Column J (index 9) should be "Rescheduled"
      expect(row.data[9]).toBe("Rescheduled");

      console.log(`  📊 Rescheduled: status=${row.data[9]}, date/time=${row.data[8]}`);
    },
    TIMEOUT
  );

  // ─── Update Learner Record (Cancel) ────────────────────────────────

  it(
    "updateLearnerRecord marks booking as cancelled",
    async () => {
      const learnerData = {
        phoneNumber: TEST_LEARNER_PHONE,
        name: "E2E Test Learner",
        location: "ST5 1AB",
      };

      const result = await sheetsService.updateLearnerRecord(
        SPREADSHEET_ID,
        learnerData,
        {},
        "cancel",
        TEST_INSTRUCTOR
      );

      expect(result).toBeDefined();

      // Verify
      const row = await sheetsService.findLearnerRow(
        SPREADSHEET_ID,
        TEST_LEARNER_PHONE,
        TEST_INSTRUCTOR
      );
      expect(row.exists).toBe(true);
      // Column H (index 7) should be "No" (lesson booked = no)
      expect(row.data[7]).toBe("No");
      // Column J (index 9) should be "Cancelled"
      expect(row.data[9]).toBe("Cancelled");

      console.log(`  📊 Cancelled: booked=${row.data[7]}, status=${row.data[9]}`);
    },
    TIMEOUT
  );

  // ─── Build Row Data Helpers ────────────────────────────────────────

  it(
    "buildNewRowData produces correct column layout",
    async () => {
      const learnerData = {
        name: "Row Test",
        phoneNumber: "447700000001",
        location: "LE1 1AA",
      };

      const bookingData = {
        date: "2026-07-01",
        time: "11:00",
        pickupAddress: "LE1 1AA",
        dropoffAddress: "LE2 2BB",
      };

      const row = await sheetsService.buildNewRowData(learnerData, bookingData);

      expect(row).toHaveLength(10);
      expect(row[0]).toBe("Row Test");          // A: name
      expect(row[1]).toBe("447700000001");      // B: phone
      expect(row[2]).toBe("LE1 1AA");           // C: location
      expect(row[3]).toBe("1");                 // D: lessons had
      expect(row[5]).toBe("LE1 1AA");           // F: pickup
      expect(row[6]).toBe("LE2 2BB");           // G: dropoff
      expect(row[7]).toBe("Yes");               // H: lesson booked
      expect(row[8]).toContain("11:00");        // I: date/time
      expect(row[9]).toBe("Confirmed");         // J: status
    }
  );

  it(
    "buildUpdatedRowData increments lesson count on 'create' action",
    async () => {
      const existingData = [
        "Test", "447700000001", "ST5", "3", "", "ST5 1AB", "ST4 2DE", "Yes", "01/06/2026 10:00", "Confirmed",
      ];

      const bookingData = {
        date: "2026-07-10",
        time: "15:00",
        pickupAddress: "ST5 1AB",
        dropoffAddress: "ST4 7PX",
      };

      const row = await sheetsService.buildUpdatedRowData(existingData, bookingData, "create");

      expect(row[3]).toBe("4");                 // D: 3 → 4
      expect(row[5]).toBe("ST5 1AB");           // F: pickup updated
      expect(row[6]).toBe("ST4 7PX");           // G: dropoff updated
      expect(row[7]).toBe("Yes");               // H: lesson booked
      expect(row[8]).toContain("15:00");        // I: new time
      expect(row[9]).toBe("Confirmed");         // J: status
    }
  );

  it(
    "buildUpdatedRowData sets 'Cancelled' status on 'cancel' action",
    async () => {
      const existingData = [
        "Test", "447700000001", "ST5", "3", "", "ST5 1AB", "ST4 2DE", "Yes", "01/06/2026 10:00", "Confirmed",
      ];

      const row = await sheetsService.buildUpdatedRowData(existingData, {}, "cancel");

      expect(row[7]).toBe("No");                // H: not booked
      expect(row[9]).toBe("Cancelled");         // J: cancelled
    }
  );

  // ─── getLearnerName ────────────────────────────────────────────────

  it(
    "getLearnerName returns bookingData name or generates fallback",
    async () => {
      const withName = await sheetsService.getLearnerName("447700000001", { learnerName: "Alice" });
      expect(withName).toBe("Alice");

      const fallback = await sheetsService.getLearnerName("447700000001", {});
      expect(fallback).toContain("0001"); // last 4 digits
    }
  );
});
