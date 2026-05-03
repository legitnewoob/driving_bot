module.exports = {
  projects: [
    {
      displayName: "unit+integration",
      testEnvironment: "node",
      testMatch: ["**/tests/**/*.test.js"],
      testPathIgnorePatterns: ["tests/e2e"],
    },
    {
      displayName: "e2e",
      testEnvironment: "node",
      testMatch: ["**/tests/e2e/**/*.e2e.test.js"],
      testTimeout: 60000,
      maxWorkers: 1, // Run E2E tests sequentially to avoid API rate limits
    },
  ],
};
