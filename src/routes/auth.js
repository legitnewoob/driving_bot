const express = require('express');
const {oauth2Client} = require('../config/google');
const Instructor = require('../models/instructorSchema');
const { invalidateInstructorCache } = require('../models/instructorModel');
const logger = require('../utils/logger-advanced');

const router = express.Router();

/**
 * GET /auth/google?phone=<instructor_phone>
 *
 * Starts the Google OAuth flow. The instructor identifies themselves by
 * providing their personal phone number as a query parameter.
 * The phone is passed through OAuth state so we can link the token on callback.
 */
router.get('/google', (req , res) => {
    const phone = req.query.phone;
    if (!phone) {
        return res.status(400).send("Please provide your phone number as a query parameter, e.g. /auth/google?phone=447700000001");
    }

    const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/calendar" , "https://www.googleapis.com/auth/spreadsheets"],
        prompt: "consent",
        state: phone,
    });
    res.redirect(url);
});

/**
 * GET /auth/oauth2callback
 *
 * Google redirects here after consent. We:
 *  1. Exchange the code for tokens
 *  2. Look up the instructor by their phone number (from OAuth state)
 *  3. Update the refresh token in the database
 *  4. Invalidate the in-memory instructor cache
 */
router.get('/oauth2callback', async (req, res) => {
    try {
        const phone = req.query.state;
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);

        if (!phone) {
            logger.warn("OAuth callback without phone state — token not saved to DB");
            return res.send("✅ Google Calendar linked! But no phone was provided so the token was not saved. Please try again with /auth/google?phone=YOUR_PHONE");
        }

        // Find instructor by phone number
        const instructor = await Instructor.findOne({ phone });
        if (!instructor) {
            logger.warn(`OAuth callback: no instructor found for phone ${phone}`);
            return res.status(404).send(`No instructor found with phone number ${phone}. Please make sure you are registered first.`);
        }

        // Update the refresh token in DB
        if (tokens.refresh_token) {
            instructor.googleRefreshToken = tokens.refresh_token;
            await instructor.save();
            invalidateInstructorCache(instructor.phoneNumberId);
            logger.info(`Refresh token updated in DB for instructor ${instructor.name} (phone: ${phone})`);
        } else {
            logger.warn(`OAuth callback for ${instructor.name}: no refresh_token in response (may already be stored)`);
        }

        res.send(`✅ Google Calendar linked for ${instructor.name}! Refresh token has been saved to the database.`);
    } catch (err) {
        logger.error(`OAuth callback error: ${err.message}`);
        res.status(500).send("Auth Error");
    }
});

module.exports = router;