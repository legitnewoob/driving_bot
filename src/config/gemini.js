const config = require("./env");

console.log("Running in:", config.env);

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// Donna's replies. Override with GEMINI_MODEL.
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Flash models "think" before answering; a small budget keeps replies quick while
// still reasoning through the booking rules. GEMINI_THINKING_BUDGET=0 turns it off.
const thinkingBudget = process.env.GEMINI_THINKING_BUDGET !== undefined
  ? Number(process.env.GEMINI_THINKING_BUDGET)
  : 512;

const model = genAI.getGenerativeModel({
  model: MODEL_NAME,
  generationConfig: {
    temperature: 0.7,
    topP: 0.9,
    maxOutputTokens: 2048,
    ...(MODEL_NAME.includes("flash") && Number.isFinite(thinkingBudget)
      ? { thinkingConfig: { thinkingBudget } }
      : {}),
  },
});

// Small structured jobs (reading dates/times out of a message) where speed matters
// more than depth. Override with GEMINI_FAST_MODEL.
const fastModel = genAI.getGenerativeModel({
  model: process.env.GEMINI_FAST_MODEL || "gemini-2.5-flash-lite",
});

module.exports = { model, fastModel, genAI };
