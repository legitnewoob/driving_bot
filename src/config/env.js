const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

// Pick environment (default: development)
const env = process.env.NODE_ENV || "development";

// Match env file
console.log(process.cwd());
const envFile = path.resolve(process.cwd() , `envs/.env.${env}`);
console.log(`Loading environment from: ${envFile}`);
// Check if file exists
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
  console.log(`✅ Loaded ${env} environment`);
} else {
  console.warn(`⚠️ No env file found for ${env}`);
}

module.exports = {
  env,
  dbUrl: process.env.DB_URL,
  apiKey: process.env.API_KEY,
};