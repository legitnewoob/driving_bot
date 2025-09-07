const config = require("./src/config/env");
const logEnvironment = require("./src/utils/envLogger");

const app = require('./app');


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🤖 Enhanced AI WhatsApp Bot server running on port ${PORT}`);
    console.log(`🌐 Root URL: http://localhost:${PORT}/`);
    console.log(`🛠️ Health Check URL: http://localhost:${PORT}/api/status/health`);
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`📅 Google Auth URL: http://localhost:${PORT}/auth/google`);
    console.log(`✨ Enhanced with automatic availability checking!`);
    logEnvironment(config.env || "development");

});