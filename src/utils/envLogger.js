// envLogger.js

async function logEnvironment(env) {
    const chalk = (await import("chalk")).default;  
    let output = "";

  switch (env?.toLowerCase()) {
    case "development":
      output = chalk.bgBlue.white.bold(`🛠️  Running in: DEVELOPMENT `);
      break;
    case "uat":
      output = chalk.bgYellow.black.bold(`🧪  Running in: UAT `);
      break;
    case "production":
      output = chalk.bgRed.white.bold(`🚀  Running in: PRODUCTION `);
      break;
    default:
      output = chalk.bgGray.white.bold(`⚙️  Running in: ${env || "UNKNOWN"} `);
      break;
  }

  console.log(output);
}

module.exports = logEnvironment;