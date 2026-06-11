const config = require("./src/config/env");
const logEnvironment = require("./src/utils/envLogger");
const { startTokenRefreshSchedule } = require("./src/utils/refreshWhatsappToken");

const app = require('./app');


const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    const chalk = (await import("chalk")).default;
    const dim = chalk.dim;
    const bold = chalk.bold;
    const cyan = chalk.cyan;
    const green = chalk.green;

    const line = dim("─".repeat(50));

    console.log();
    console.log(line);
    console.log(bold.cyan("  Donna - WhatsApp Driving School Bot"));
    console.log(line);
    console.log();
    console.log(`  ${green("●")} Server running on port ${bold(PORT)}`);
    console.log();
    console.log(dim("  Routes:"));
    console.log(`    ${dim("Root")}           ${cyan(`http://localhost:${PORT}/`)}`);
    console.log(`    ${dim("Health")}         ${cyan(`http://localhost:${PORT}/api/status/health`)}`);
    console.log(`    ${dim("Webhook")}        ${cyan(`http://localhost:${PORT}/webhook`)}`);
    console.log(`    ${dim("Google Auth")}    ${cyan(`http://localhost:${PORT}/auth/google?phone=YOUR_PHONE`)}`);
    console.log();
    logEnvironment(config.env || "development");
    console.log(line);
    console.log();

    // Refresh WhatsApp token on startup and every 7 days
    startTokenRefreshSchedule();
});