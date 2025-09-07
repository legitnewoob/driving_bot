const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

// 1. Load root .env first
// console.log(process.cwd());
const rootEnvFile = path.resolve(process.cwd(), ".env");
if (fs.existsSync(rootEnvFile)) {
  dotenv.config({ path: rootEnvFile });
  console.log(`✅ Loaded root .env`);
}


// // 1. Load root .env first
// // console.log(process.cwd());
// const rootEnvFile = path.resolve(process.cwd(), ".env");
// if (fs.existsSync(rootEnvFile)) {
//   dotenv.config({ path: rootEnvFile });
//   console.log(`✅ Loaded root .env`);
// }


// Pick environment (default: development)
console.log("LET'S CHECK" , process.env.NODE_ENV);

const env = process.env.NODE_ENV || "development";

console.log(`Starting in ${env} mode...`);

console.log(`Starting in ${env} mode...`);

// Match env file
console.log(process.cwd());
const envFile = path.resolve(process.cwd() , `envs/.env.${env}`);
console.log(`Loading environment from: ${envFile}`);
// Check if file exists
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile  , override: true });
  console.log(`✅ Loaded ${env} environment`);
} else {
  console.warn(`⚠️ No env file found for ${env}`);
}

console.log("LET'S CHECK" , process.env.REMOVED_TOKEN , process.env.DB_NAME);
module.exports = {
  env,
  dbUrl: process.env.DB_NAME,
  dbUrl: process.env.DB_NAME,
  apiKey: process.env.API_KEY,
};