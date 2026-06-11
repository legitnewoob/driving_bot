/**
 * WhatsApp Mock Server
 * ---------------------
 * Forwards messages to your core app via HTTP and shows replies in the UI.
 *
 * Usage:
 *   npm install express socket.io cors axios
 *   node server.js
 *
 * Then open http://localhost:3000
 * Your core app must be running on APP_URL (default: http://localhost:3000/webhook)
 */

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path    = require("path");
const axios = require("axios");
// ─── Config ───────────────────────────────────────────────────────────────────
const MOCK_PORT        = process.env.MOCK_PORT        || 4000;
const APP_URL          = process.env.APP_URL          || "http://localhost:3000/mock-webhook";
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID  || "886622201206248";

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Mock WhatsApp payload factory ───────────────────────────────────────────
function buildWhatsAppPayload(text, fromNumber = "917726877146") {
  const msgId = "wamid." + Math.random().toString(36).slice(2, 18).toUpperCase();
  const ts    = Math.floor(Date.now() / 1000).toString();

  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "MOCK_BUSINESS_ACCOUNT_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "15550001234",
            phone_number_id: PHONE_NUMBER_ID,
          },
          contacts: [{
            profile: { name: "Dev User" },
            wa_id: fromNumber,
          }],
          messages: [{
            from:      fromNumber,
            id:        msgId,
            timestamp: ts,
            type:      "text",
            text:      { body: text },
          }],
        },
      }],
    }],
  };
}

// ─── Socket.io — bridges UI ↔ your core app ──────────────────────────────────
io.on("connection", (socket) => {
  console.log("[mock] Dev UI connected:", socket.id);

  socket.on("user_message", async ({ text, from }) => {
    console.log(`[mock] → forwarding to app: "${text}" from ${from}`);

    const payload = buildWhatsAppPayload(text, from);

    let response, data;

    try {
      // Forward the exact WhatsApp-shaped payload to your core app
      response = await axios.post(APP_URL, payload, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[mock] Could not reach your app:", err.message);
      socket.emit("bot_error", {
        message: `Could not reach your app at ${APP_URL} — is it running?`,
      });
      return;
    }

    data = response.data;
    // Supports single reply or multiple: { reply: "..." } or { reply: ["a", "b"] }
    const replies = Array.isArray(data.reply) ? data.reply : [data.reply];

    for (const reply of replies) {
      if (reply) {
        console.log(`[mock] ← app replied: "${reply}"`);
        socket.emit("bot_message", { text: reply, to: from });
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("[mock] Dev UI disconnected:", socket.id);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(MOCK_PORT, () => {
  console.log(`\n✅  WhatsApp Mock Server running`);
  console.log(`   UI       → http://localhost:${MOCK_PORT}`);
  console.log(`   Forwards → ${APP_URL}\n`);
});