// refreshWhatsAppToken.js
const axios = require("axios");
const env = require("../config/env"); // Load environment variables
async function getLongLivedToken() {
  const APP_ID = process.env.META_APP_ID;
  const APP_SECRET = process.env.REMOVED_SECRET;
  const SHORT_TOKEN = process.env.WHATSAPP_TOKEN;

  if (!APP_ID || !APP_SECRET || !SHORT_TOKEN) {
    throw new Error("❌ Missing META_APP_ID, REMOVED_SECRET, or WHATSAPP_SHORT_TOKEN in .env");
  }

  const url = `https://graph.facebook.com/v21.0/oauth/access_token` +
              `?grant_type=fb_exchange_token` +
              `&client_id=${APP_ID}` +
              `&client_secret=${APP_SECRET}` +
              `&fb_exchange_token=${SHORT_TOKEN}`;

  try {
    const { data } = await axios.get(url);

    console.log("✅ Successfully retrieved long-lived token");
    console.log("🔑 Long-lived Token:", data.access_token);
    console.log("⏳ Expires in (seconds):", data.expires_in);

    return data.access_token;
  } catch (err) {
    console.error("❌ Error refreshing token:", err.response?.data || err.message);
    process.exit(1);
  }
}

// If script is run directly from CLI
if (require.main === module) {
  getLongLivedToken();
}

// Export for use in other modules
module.exports = getLongLivedToken;