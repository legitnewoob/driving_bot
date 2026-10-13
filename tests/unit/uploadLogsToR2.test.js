/**
 * R2 log backup: only changed files are re-sent, and an unreachable R2 produces
 * one short message per run instead of a stack trace per file.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "r2-logs-"));
jest.mock("../../src/utils/projectRoot", () => mockRoot);
jest.mock("../../src/config/r2Client", () => ({ send: jest.fn() }));

process.env.R2_BUCKET = "bucket";
process.env.R2_ENDPOINT = "https://example.r2.cloudflarestorage.com";
process.env.R2_DIRECTORY = "donna-dev";

const r2 = require("../../src/config/r2Client");
const uploadLogsFolder = require("../../src/utils/uploadLogsToR2");

const dayDir = path.join(mockRoot, "message-logs", "2026-10-11");

beforeAll(() => {
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, "a.log"), "hello");
  fs.writeFileSync(path.join(dayDir, "b.log"), "world");
});

afterAll(() => fs.rmSync(mockRoot, { recursive: true, force: true }));

beforeEach(() => {
  r2.send.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

it("stops after the first connection error and logs one line", async () => {
  r2.send.mockRejectedValue(Object.assign(new Error(""), { code: "ECONNREFUSED" }));

  await uploadLogsFolder();

  expect(r2.send).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledTimes(1);
  expect(console.error.mock.calls[0][0]).toMatch(/can't reach R2 \(ECONNREFUSED\)/);
});

it("uploads each file once, then only files that changed", async () => {
  r2.send.mockResolvedValue({});

  await uploadLogsFolder();
  expect(r2.send).toHaveBeenCalledTimes(2);

  await uploadLogsFolder();
  expect(r2.send).toHaveBeenCalledTimes(2); // nothing changed

  const file = path.join(dayDir, "a.log");
  fs.appendFileSync(file, " again");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);

  await uploadLogsFolder();
  expect(r2.send).toHaveBeenCalledTimes(3);
  expect(r2.send.mock.calls[2][0].input.Key).toBe("donna-dev/logs/2026-10-11/a.log");
});
