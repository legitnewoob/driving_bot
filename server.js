require('dotenv').config();
const app = require('./app');

const logger = require('./logger');

logger.info('Server started');
logger.error('Something went wrong');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    logger.info('App listening on port 3000');
    console.log(`🤖 Enhanced AI WhatsApp Bot server running on port ${PORT}`);
    console.log(`🌐 Root URL: http://localhost:${PORT}/`);
    console.log(`🛠️ Health Check URL: http://localhost:${PORT}/api/status/health`);
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`📅 Google Auth URL: http://localhost:${PORT}/auth/google`);
    console.log(`✨ Enhanced with automatic availability checking!`);
});