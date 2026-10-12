const config = require("./env");

console.log("Running in:", config.env);

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// Available models:
// - gemini-1.5-flash (fastest, cheapest)
// - gemini-1.5-pro (most capable)
// - gemini-1.0-pro (legacy, cheaper)

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-pro",
  generationConfig: {
    temperature: 0.7,
    topP: 0.9,
    maxOutputTokens: 2048,
  },
});


module.exports = { model, genAI };
