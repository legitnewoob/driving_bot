const config = require("./env");

console.log("Running in:", config.env);
console.log("DB URL:", config.dbUrl);

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// Available models:
// - gemini-1.5-flash (fastest, cheapest)
// - gemini-1.5-pro (most capable)
// - gemini-1.0-pro (legacy, cheaper)

const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.7,
    topP: 0.8,
    topK: 40,
    maxOutputTokens: 500,
  },
});



module.exports = { model, genAI };
