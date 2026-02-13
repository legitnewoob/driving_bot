const express = require('express');
const authRoutes = require('./src/routes/auth');
const webhookRoutes = require('./src/routes/webhook');
const healthRoutes = require('./src/routes/status');
const logRoutes = require('./src/routes/fetchLogs');
const connectDB = require("./src/config/database");
const uploadLogsFolder = require("./src/utils/uploadLogsToR2");
const path = require("path");
const rateLimit = require("express-rate-limit");
const basicAuth = require("express-basic-auth");

// Rate Limiter
const logLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests. Please try again later."
});

// Basic Auth 
const logAuth = basicAuth({
  users: {
    admin: process.env.LOGS_ADMIN_PASSWORD
  },
  challenge: true, // shows browser login popup
  realm: "Donna Logs"
});



const app = express();



// Middleware
app.use(express.json());
connectDB();

// Routes
app.use('/webhook', webhookRoutes);
app.use('/auth' , authRoutes);
app.use('/api/status', healthRoutes);
app.use('/api/logs', logAuth, logLimiter, logRoutes);

// Logs Viewer Page
app.get("/logs-viewer", logAuth , logLimiter , (req, res) => {
  res.sendFile(path.join(__dirname, "public/logs.html"));
});

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
setInterval(uploadLogsFolder, process.env.WAIT_FOR_R2_IN_MINS * 60 * 1000); 

module.exports = app;