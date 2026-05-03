/**
 * Email Notifier – Unit Tests
 * ────────────────────────────
 * Covers:
 *  1. sendNotification – transporter creation, email sending, missing env vars
 *  2. notifyInvalidGrant – email content, instructor details, re-auth URL
 *  3. Cooldown / deduplication – prevents spam for the same error
 *  4. Error handling – transporter failures
 */

jest.mock("nodemailer");
jest.mock("../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const nodemailer = require("nodemailer");
const logger = require("../src/utils/logger-advanced");
const {
  sendNotification,
  notifyInvalidGrant,
  clearCooldowns,
  resetTransporter,
} = require("../src/utils/emailNotifier");

// ── Mock transporter ─────────────────────────────────────────────────────

const mockSendMail = jest.fn().mockResolvedValue({ messageId: "test-123" });

nodemailer.createTransport.mockReturnValue({
  sendMail: mockSendMail,
});

// ═══════════════════════════════════════════════════════════════════════════
// Setup / Teardown
// ═══════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  jest.clearAllMocks();
  clearCooldowns();
  resetTransporter();
  process.env.NOTIFY_EMAIL_USER = "bot@gmail.com";
  process.env.NOTIFY_EMAIL_PASS = "test-app-password";
  process.env.NOTIFY_EMAIL_TO = "admin@gmail.com";
  process.env.BASE_URL = "https://mybot.example.com";

  // Re-mock after reset
  nodemailer.createTransport.mockReturnValue({
    sendMail: mockSendMail,
  });
});

afterAll(() => {
  delete process.env.NOTIFY_EMAIL_USER;
  delete process.env.NOTIFY_EMAIL_PASS;
  delete process.env.NOTIFY_EMAIL_TO;
  delete process.env.BASE_URL;
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. sendNotification
// ═══════════════════════════════════════════════════════════════════════════

describe("sendNotification", () => {
  it("creates a Gmail transporter and sends email", async () => {
    const result = await sendNotification("Test Subject", "<p>Hello</p>");

    expect(result).toBe(true);
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      service: "gmail",
      auth: { user: "bot@gmail.com", pass: "test-app-password" },
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@gmail.com",
        subject: "Test Subject",
        html: "<p>Hello</p>",
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Email notification sent")
    );
  });

  it("returns false and logs warning when NOTIFY_EMAIL_USER is missing", async () => {
    delete process.env.NOTIFY_EMAIL_USER;
    resetTransporter();

    const result = await sendNotification("Subject", "<p>Body</p>");

    expect(result).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("NOTIFY_EMAIL_USER")
    );
  });

  it("returns false and logs warning when NOTIFY_EMAIL_PASS is missing", async () => {
    delete process.env.NOTIFY_EMAIL_PASS;
    resetTransporter();

    const result = await sendNotification("Subject", "<p>Body</p>");

    expect(result).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("falls back to NOTIFY_EMAIL_USER as recipient when NOTIFY_EMAIL_TO is not set", async () => {
    delete process.env.NOTIFY_EMAIL_TO;
    resetTransporter();

    await sendNotification("Subject", "<p>Body</p>");

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "bot@gmail.com" })
    );
  });

  it("returns false when sendMail throws", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("SMTP connection refused"));

    const result = await sendNotification("Subject", "<p>Body</p>");

    expect(result).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("SMTP connection refused")
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. notifyInvalidGrant
// ═══════════════════════════════════════════════════════════════════════════

describe("notifyInvalidGrant", () => {
  const instructor = {
    name: "John Instructor",
    phoneNumberId: "123456789",
    phone: "447700000001",
    email: "john@example.com",
  };

  it("sends an email with instructor details and re-auth link", async () => {
    const result = await notifyInvalidGrant(instructor, "Calendar", "invalid_grant: Token expired");

    expect(result).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    const sentEmail = mockSendMail.mock.calls[0][0];

    // Subject contains instructor name and service
    expect(sentEmail.subject).toContain("John Instructor");
    expect(sentEmail.subject).toContain("Calendar");

    // Body contains all instructor details
    expect(sentEmail.html).toContain("John Instructor");
    expect(sentEmail.html).toContain("123456789");
    expect(sentEmail.html).toContain("447700000001");
    expect(sentEmail.html).toContain("john@example.com");
    expect(sentEmail.html).toContain("Calendar");
    expect(sentEmail.html).toContain("invalid_grant");

    // Body contains re-auth URL
    expect(sentEmail.html).toContain("https://mybot.example.com/auth/google?phone=447700000001");
  });

  it("handles missing instructor fields gracefully", async () => {
    const result = await notifyInvalidGrant({}, "Sheets", "invalid_grant");

    expect(result).toBe(true);
    const sentEmail = mockSendMail.mock.calls[0][0];
    expect(sentEmail.html).toContain("Unknown");
    expect(sentEmail.html).toContain("Sheets");
  });

  it("uses localhost as fallback when BASE_URL is not set", async () => {
    delete process.env.BASE_URL;

    await notifyInvalidGrant(instructor, "Calendar", "invalid_grant");

    const sentEmail = mockSendMail.mock.calls[0][0];
    expect(sentEmail.html).toContain("http://localhost:3000/auth/google");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cooldown / Deduplication
// ═══════════════════════════════════════════════════════════════════════════

describe("Cooldown", () => {
  it("sends the first notification but skips the second within cooldown", async () => {
    const r1 = await sendNotification("Alert", "<p>1</p>", "test-key");
    expect(r1).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    const r2 = await sendNotification("Alert", "<p>2</p>", "test-key");
    expect(r2).toBe(false);
    expect(mockSendMail).toHaveBeenCalledTimes(1); // still 1
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("cooldown")
    );
  });

  it("allows different dedupeKeys to send independently", async () => {
    await sendNotification("A", "<p>A</p>", "key-a");
    await sendNotification("B", "<p>B</p>", "key-b");

    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  it("sends without dedupeKey every time (no cooldown)", async () => {
    await sendNotification("A", "<p>1</p>");
    await sendNotification("A", "<p>2</p>");

    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  it("notifyInvalidGrant deduplicates by instructor phoneNumberId", async () => {
    const inst = { name: "Test", phoneNumberId: "pn-123", phone: "447", email: "t@t.com" };

    await notifyInvalidGrant(inst, "Calendar", "err1");
    await notifyInvalidGrant(inst, "Calendar", "err2"); // same instructor, within cooldown

    expect(mockSendMail).toHaveBeenCalledTimes(1); // only first sent
  });

  it("clearCooldowns allows sending again", async () => {
    await sendNotification("A", "<p>1</p>", "key-x");
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    clearCooldowns();

    await sendNotification("A", "<p>2</p>", "key-x");
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });
});
