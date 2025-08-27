const express = require('express');
const {oauth2Client} = require('../config/google');

const router = express.Router();


router.get('/google', (req , res) => {
        const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/calendar" , "https://www.googleapis.com/auth/spreadsheets"],
        prompt: "consent"
    });
    res.redirect(url);
});
router.get('/oauth2callback', async (req, res) => {
    try {
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);
        console.log("Tokens:", tokens);
        res.send("✅ Google Calendar linked! Save your refresh_token in your .env file.");
    } catch (err) {
        console.error(err);
        res.status(500).send("Auth Error");
    }});

module.exports = router;