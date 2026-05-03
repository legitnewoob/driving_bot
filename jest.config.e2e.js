/**
 * Jest config for E2E tests.
 * Uses real Gemini, real DB, real sessions — only mocks calendar/sheets/whatsapp.
 * Run with: npm run test:e2e
 */
module.exports = {
  testMatch: ["**/tests/e2e/**/*.e2e.test.js"],
  testTimeout: 60000,
};
