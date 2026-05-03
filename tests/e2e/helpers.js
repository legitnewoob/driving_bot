/**
 * E2E Test Helpers
 * ─────────────────
 * Shared utilities for end-to-end tests that call the real Gemini API.
 *
 * Requirements:
 *   - GOOGLE_AI_API_KEY env var must be set (from .env or exported)
 *
 * Usage:
 *   const { getModel, buildPrompt, askGemini, extractAction } = require("./helpers");
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "..", "SYSTEM_PROMPT.txt");

let _model = null;

/**
 * Get or create the Gemini model instance.
 * Throws if GOOGLE_AI_API_KEY is not set.
 */
function getModel() {
  if (_model) return _model;

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_AI_API_KEY is required for e2e tests. " +
      "Set it in your .env file or export it: export GOOGLE_AI_API_KEY=your-key"
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  _model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      temperature: 0.7,
      topP: 0.8,
      topK: 40,
      maxOutputTokens: 500,
    },
  });

  return _model;
}

/**
 * Read the real system prompt and inject instructor name.
 */
function getSystemPrompt(instructorName = "Test Instructor") {
  const raw = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  return raw.replace(/\{\{INSTRUCTOR_NAME\}\}/g, instructorName);
}

/**
 * Build a full prompt string in the same format aiService uses.
 */
function buildPrompt(userMessage, opts = {}) {
  const {
    instructorName = "Test Instructor",
    conversationHistory = [],
    systemSuffix = "",
  } = opts;

  const systemPrompt = getSystemPrompt(instructorName);
  const today = new Date().toISOString().split("T")[0];

  let conv = `${systemPrompt}\n\nTODAY's date (Europe/London): ${today}\n\nCONVERSATION HISTORY:\n`;

  conversationHistory.forEach((msg) => {
    const role = msg.role === "user" ? "User" : "Assistant";
    conv += `${role}: ${msg.content}\n`;
  });

  conv += `\nUser: ${userMessage}${systemSuffix}\n\nAssistant: `;
  return conv;
}

/**
 * Send a message to the real Gemini API and return the raw text response.
 */
async function askGemini(userMessage, opts = {}) {
  const model = getModel();
  const prompt = buildPrompt(userMessage, opts);
  const result = await model.generateContent(prompt);
  return result.response.text();
}

/**
 * Extract the action block from an AI response (same regex as aiService).
 */
function extractAction(aiResponse) {
  const ACTION_REGEX =
    /\[ACTION:(BOOK|UPDATE_BOOKING|CANCEL_BOOKING|SHOW_BOOKINGS|NEXT_AVAILABLE_SLOT|NULL)\]\s*(\{[\s\S]*?\})?\s*$/;

  const match = aiResponse.match(ACTION_REGEX);
  if (!match) return { actionType: null, bookingData: null, responseText: aiResponse };

  let bookingData = null;
  try {
    if (match[2]) bookingData = JSON.parse(match[2]);
  } catch (_) {}

  return {
    actionType: match[1],
    bookingData,
    responseText: aiResponse.replace(ACTION_REGEX, "").trim(),
  };
}

module.exports = { getModel, getSystemPrompt, buildPrompt, askGemini, extractAction };
