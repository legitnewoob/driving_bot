const express = require('express');
const authRoutes = require('./src/routes/auth');
const webhookRoutes = require('./src/routes/webhook');
const healthRoutes = require('./src/routes/status');
const connectDB = require("./src/config/database");
const uploadLogsFolder = require("./src/utils/uploadLogsToR2");

const app = express();

// Middleware
app.use(express.json());
connectDB();


// Routes
app.use('/webhook', webhookRoutes);
app.use('/auth' , authRoutes);
app.use('/api/status', healthRoutes);

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        success: true, 
        response: "🤖 Enhanced AI WhatsApp Driving School Bot with Automatic Availability Checking! 🚗📅✨",
        features: [
            "✅ Automatic date/time extraction from user messages",
            "✅ Real-time calendar availability checking", 
            "✅ Smart availability suggestions",
            "✅ Enhanced AI responses with availability context",
            "✅ Seamless booking flow"
        ]
    });
});

// Session cleanup
const { cleanupSessions , cleanUpContexts} = require('./src/utils/helpers');
setInterval(cleanUpContexts, 1 * 60 * 1000); // every 5 minutes
setInterval(cleanupSessions, 10 * 60 * 1000); // every 10 minutes

// Upload logs to R2 every 5 minutes
setInterval(uploadLogsFolder, 60 * 60 * 1000); 

module.exports = app;