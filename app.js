const express = require('express');
const authRoutes = require('./src/routes/auth');
const contactRoutes = require('./src/routes/contact');
const waitlistRoutes = require('./src/routes/waitlist');
const authGoogleRoutes = require('./src/routes/authGoogle');
const webhookRoutes = require('./src/routes/webhook');
const healthRoutes = require('./src/routes/status');
const logRoutes = require('./src/routes/fetchLogs');
const bookingRoutes = require('./src/routes/bookings');
const dashboardRoutes = require('./src/routes/dashboard');
const schoolRoutes = require('./src/routes/school');
const learnerRoutes = require('./src/routes/learners');
const stripeRoutes = require('./src/routes/stripe');
const stripeWebhookHandler = require('./src/routes/stripeWebhook');
const phoneNumberRoutes = require('./src/routes/phoneNumbers');
const adminRoutes = require('./src/routes/admin');
const pricingRoutes = require('./src/routes/pricing');
const connectDB = require("./src/config/database");
const uploadLogsFolder = require("./src/utils/uploadLogsToR2");
const path = require("path");
const rateLimit = require("express-rate-limit");
const basicAuth = require("express-basic-auth");
const jwtAuth = require("./src/middleware/jwtAuth");
const apiKeyAuth = require("./src/middleware/apiKeyAuth");
const adminAuth = require("./src/middleware/adminAuth");
const requirePlan = require("./src/middleware/requirePlan");



// Startup env validation
if (process.env.NODE_ENV === 'production') {
  const required = ['JWT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'MONGO_URI', 'GOOGLE_CLIENT_ID', 'ADMIN_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`FATAL: Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const app = express();


// IMPORTANT: trust first proxy
app.set('trust proxy', 1);



// Rate Limiters
const logLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests. Please try again later."
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many auth attempts. Please try again later." },
  skip: (req) => {
    // Don't rate-limit authenticated read endpoints — only limit public signup/exchange
    const openPaths = ["/google-signup", "/exchange-code"];
    return !openPaths.some(p => req.path.startsWith(p));
  },
});

// Public contact form: a handful per visitor is plenty
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many messages. Please try again later or email us." },
});

// Basic Auth 
const logAuth = basicAuth({
  users: {
    admin: process.env.LOGS_ADMIN_PASSWORD
  },
  challenge: true, // shows browser login popup
  realm: "Donna Logs"
});


// CORS (manual middleware — supports multiple allowed origins)
// FRONTEND_URL / PORTAL_URL, each with and without "www.", plus any extra origins
// in CORS_ORIGINS (comma-separated). Origins must match exactly, so normalise them.
const withAndWithoutWww = (url) => {
  try {
    const u = new URL(url);
    const bare = u.hostname.replace(/^www\./, "");
    return [`${u.protocol}//${bare}${u.port ? `:${u.port}` : ""}`, `${u.protocol}//www.${bare}${u.port ? `:${u.port}` : ""}`];
  } catch {
    return [];
  }
};
const ALLOWED_ORIGINS = [
  ...new Set(
    [process.env.FRONTEND_URL, process.env.PORTAL_URL, ...(process.env.CORS_ORIGINS || "").split(",")]
      .map((o) => (o || "").trim())
      .filter(Boolean)
      .flatMap(withAndWithoutWww)
  ),
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Stripe webhook needs raw body — must be mounted BEFORE express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// Middleware
app.use(express.json());
connectDB();

// Routes
app.use('/webhook', webhookRoutes);
app.use('/auth' , authRoutes);
app.use('/api/auth', authLimiter, authGoogleRoutes);
app.use('/api/stripe', jwtAuth, stripeRoutes);
app.use('/api/status', healthRoutes);
app.use('/api/logs', logAuth, logLimiter, logRoutes);
app.use('/api/bookings', adminAuth, bookingRoutes);
app.use('/api/dashboard', jwtAuth, requirePlan, dashboardRoutes);
app.use('/api/school', schoolRoutes);
app.use('/api/contact', contactLimiter, contactRoutes); // public: website contact form
app.use('/api', waitlistRoutes); // public: /api/launch and /api/waitlist (launch waitlist)
app.use('/api/pricing', pricingRoutes); // public: plans and the active sale for the website // public invite lookup inside; everything else needs JWT
app.use('/api/learners', apiKeyAuth, requirePlan, learnerRoutes);
app.use('/api/phone-numbers', jwtAuth, requirePlan, phoneNumberRoutes);
app.use('/api/admin', adminAuth, adminRoutes);

// Mock Route (development only)
if (process.env.NODE_ENV === 'development') {
  const mockWebhookRoutes = require('./src/routes/mockWebhook.js');
  app.use('/mock-webhook', mockWebhookRoutes);
  console.log('🧪 Mock webhook route enabled at POST /mock-webhook');
}

// Local email outbox (EMAIL_OUTBOX=local): never in production
if (process.env.NODE_ENV !== 'production' && process.env.EMAIL_OUTBOX === 'local') {
  app.use('/dev/outbox', require('./src/routes/devOutbox'));
  console.log('📬 Email outbox at /dev/outbox (emails are kept, not sent)');
}

// Logs Viewer Page
app.get("/logs-viewer", logAuth , logLimiter , (req, res) => {
  res.sendFile(path.join(__dirname, "public/logs.html"));
});

// Unauthenticated health check for load balancers / uptime monitors
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: `${Math.floor(process.uptime())}s` });
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

// Upload logs to R2 (WAIT_FOR_R2_IN_MINS, default 5 minutes)
const r2Minutes = Number(process.env.WAIT_FOR_R2_IN_MINS) > 0 ? Number(process.env.WAIT_FOR_R2_IN_MINS) : 5;
setInterval(uploadLogsFolder, r2Minutes * 60 * 1000);

// Graceful shutdown
const mongoose = require("mongoose");
process.on('SIGTERM', async () => {
  console.log('[app] SIGTERM received, shutting down...');
  await mongoose.connection.close();
  process.exit(0);
});

module.exports = app;