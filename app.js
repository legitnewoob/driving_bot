const express = require('express');
const authRoutes = require('./src/routes/auth');
const webhookRoutes = require('./src/routes/webhook');
// const testRoutes = require('./src/routes/test');
const connectDB = require("./src/config/database");

const app = express();

// Middleware
app.use(express.json());
connectDB();


// Routes
// app.use('/auth', authRoutes);
app.use('/webhook', webhookRoutes);
app.use('/auth' , authRoutes);
// app.use('/test', testRoutes);

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
const { cleanupSessions } = require('./src/utils/helpers');
setInterval(cleanupSessions, 10 * 60 * 1000);

module.exports = app;