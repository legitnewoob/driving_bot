const express = require('express');
const cors = require('cors');
const authRoutes = require('./src/routes/auth');
const webhookRoutes = require('./src/routes/webhook');
const healthRoutes = require('./src/routes/status');
const logRoutes = require('./src/routes/fetchLogs');
const bookingRoutes = require('./src/routes/bookings');
const learnerRoutes = require('./src/routes/learners');
const connectDB = require("./src/config/database");
const uploadLogsFolder = require("./src/utils/uploadLogsToR2");
const path = require("path");
const rateLimit = require("express-rate-limit");
const basicAuth = require("express-basic-auth");



const app = express();


// IMPORTANT: trust first proxy
app.set('trust proxy', 1);



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


// CORS (scoped to the instructor dashboard's origins)
const dashboardOrigins = (process.env.DASHBOARD_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use('/api/learners', cors({ origin: dashboardOrigins }));

// Middleware
app.use(express.json());
connectDB();

// Routes
app.use('/webhook', webhookRoutes);
app.use('/auth' , authRoutes);
app.use('/api/status', healthRoutes);
app.use('/api/logs', logAuth, logLimiter, logRoutes);
app.use('/api/bookings', logAuth, bookingRoutes);
app.use('/api/learners', learnerRoutes);

// Mock Route (development only)
if (process.env.NODE_ENV === 'development') {
  const mockWebhookRoutes = require('./src/routes/mockWebhook.js');
  app.use('/mock-webhook', mockWebhookRoutes);
  console.log('🧪 Mock webhook route enabled at POST /mock-webhook');
}

// Logs Viewer Page
app.get("/logs-viewer", logAuth , logLimiter , (req, res) => {
  res.sendFile(path.join(__dirname, "public/logs.html"));
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: "ok",
        name: "Donna",
        description: "WhatsApp Driving School Bot",
        version: require('./package.json').version || "1.0.0",
        uptime: `${Math.floor(process.uptime())}s`,
    });
});




// Session cleanup
const { cleanupSessions , cleanUpContexts} = require('./src/utils/helpers');
setInterval(cleanUpContexts, 1 * 60 * 1000); // every 5 minutes
setInterval(cleanupSessions, 10 * 60 * 1000); // every 10 minutes

// Upload logs to R2 every 5 minutes
setInterval(uploadLogsFolder, process.env.WAIT_FOR_R2_IN_MINS * 60 * 1000); 

module.exports = app;