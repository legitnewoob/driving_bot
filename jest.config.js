module.exports = {
  projects: [
    {
      displayName: "unit+integration",
      testEnvironment: "node",
      testMatch: ["**/tests/**/*.test.js"],
      testPathIgnorePatterns: ["tests/e2e"],
    },
    // Delegate the e2e project to jest.config.e2e.js so there's a single
    // source of truth (setupFiles, timeouts, etc).
    "<rootDir>/jest.config.e2e.js",
  ],
};
