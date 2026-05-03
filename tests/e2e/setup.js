/**
 * Jest setupFiles entry for e2e tests.
 *
 * This runs ONCE per test file, BEFORE any `require()` in the test file
 * (and before jest.mock factories execute). That makes it the canonical
 * place to:
 *   1. Set NODE_ENV / LOAD_ENV
 *   2. Load envs/.env.test so process.env is populated
 *
 * This way the test files (and helpers.js) can simply assume env is ready,
 * and `Debug Test` from VS Code works without any extra config.
 */
process.env.NODE_ENV = "test";
process.env.LOAD_ENV = "test";

// Loading src/config/env reads envs/.env.test and populates process.env
require("../../src/config/env");
