const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const PROJECT_ROOT = require("../utils/projectRoot.js");

console.log("Project Root:", PROJECT_ROOT);

// Load root .env
const rootEnv = path.join(PROJECT_ROOT, ".env");
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}

// Env
console.log("NODE_ENV:", process.env.NODE_ENV);

const env = process.env.NODE_ENV || "uat";
let envFile = path.join(PROJECT_ROOT, `.env`);

if(env === "development" || env === "test") {
  console.log(`Loading ${env} environment variables...`);
  envFile = path.join(PROJECT_ROOT, `envs/.env.${process.env.LOAD_ENV || env}`);
}

console.log("Loading environment from:", envFile);

if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile, override: true });
} else if(env === "development" || env === "test") {
  console.warn(`⚠️ No env file found for ${env}`);
}

module.exports = { env };