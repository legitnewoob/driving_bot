/**
 * Jest config for E2E tests.
 * ──────────────────────────
 * Uses real Gemini, real DB, real sessions — only mocks calendar/sheets/whatsapp.
 *
 * Single source of truth for running e2e tests:
 *   npm run test:e2e                          # all e2e tests
 *   npm run test:e2e -- bookingFlow           # one file (matches path)
 *   npm run test:e2e -- -t "date-only"        # one test by name
 *
 * Debugging from VS Code:
 *   Just click the "Debug" lens above any it() — .vscode/launch.json wires
 *   it to use this config.
 */
module.exports = {
  displayName: "e2e",
  testEnvironment: "node",
  testMatch: ["**/tests/e2e/**/*.e2e.test.js"],
  testTimeout: 60000,
  maxWorkers: 1, // sequential — avoids API rate limits + DB conflicts

  // Loads envs/.env.test BEFORE any test code or jest.mock factories run.
  // This is what makes Debug-from-VS-Code work seamlessly.
  setupFiles: ["<rootDir>/tests/e2e/setup.js"],
};
