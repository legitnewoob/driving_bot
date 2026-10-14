const express = require('express');
const {oauth2Client} = require('../config/google');
const Instructor = require('../models/instructorSchema');
const { invalidateInstructorCache } = require('../models/instructorModel');
const logger = require('../utils/logger-advanced');

const router = express.Router();

/**
 * GET /auth/google?phone=<instructor_phone>
 *
 * Starts the Google OAuth flow for the WhatsApp bot setup path.
 * State = instructor phone number.
 */
router.get('/google', (req , res) => {
    const phone = req.query.phone;
    if (!phone) {
        return res.status(400).send("Please provide your phone number as a query parameter, e.g. /auth/google?phone=447700000001");
    }

    const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/calendar"],
        prompt: "consent",
        state: `phone:${phone}`,
    });
    res.redirect(url);
});

/**
 * GET /auth/oauth2callback
 *
 * Google redirects here after consent. Supports two state formats:
 *   phone:<number>   — legacy WhatsApp bot setup path (looks up by phone)
 *   email:<address>  — dashboard path (looks up by email, redirects to dashboard on success)
 *
 * Old plain-phone states (no prefix) are treated as phone: for backward compat.
 */
router.get('/oauth2callback', async (req, res) => {
    try {
        const state = req.query.state || '';
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);

        if (!state) {
            logger.warn("OAuth callback without state — token not saved to DB");
            return res.send("✅ Google Calendar linked! But no state was provided so the token was not saved.");
        }

        let instructor;
        let isDashboardFlow = false;

        if (state.startsWith('email:')) {
            // Dashboard flow — look up by email
            const email = state.slice('email:'.length);
            isDashboardFlow = true;
            instructor = await Instructor.findOne({ email, active: true });
            if (!instructor) {
                logger.warn(`OAuth callback: no instructor found for email ${email}`);
                const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:8080';
                return res.redirect(`${dashboardUrl}/get-onboard?calendar=error&reason=not_found`);
            }
        } else {
            // Phone flow — strip "phone:" prefix if present (backward compat)
            const phone = state.startsWith('phone:') ? state.slice('phone:'.length) : state;
            instructor = await Instructor.findOne({ phone });
            if (!instructor) {
                logger.warn(`OAuth callback: no instructor found for phone ${phone}`);
                return res.status(404).send(`No instructor found with phone number ${phone}.`);
            }
        }

        // Store the refresh token and clear any expiry flag
        if (tokens.refresh_token) {
            instructor.googleRefreshToken = tokens.refresh_token;
            instructor.calendarTokenExpired = false;
            await instructor.save();
            invalidateInstructorCache(instructor.phoneNumberId);
            logger.info(`Refresh token updated for instructor ${instructor.name}`);
        } else {
            // Google only returns refresh_token on first consent — token is already stored
            // Still clear the expired flag since the user just re-authed
            instructor.calendarTokenExpired = false;
            await instructor.save();
            logger.warn(`OAuth callback for ${instructor.name}: no refresh_token (already stored or re-consent not triggered)`);
        }

        if (isDashboardFlow) {
            const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:8080';
            return res.redirect(`${dashboardUrl}/get-onboard?calendar=connected`);
        }

        res.send(`✅ Google Calendar linked for ${instructor.name}! Refresh token has been saved to the database.`);
    } catch (err) {
        logger.error(`OAuth callback error: ${err.message}`);
        if (err.message?.includes('invalid_grant') || err.message?.includes('code')) {
            return res.status(400).send("Auth failed — the authorisation code may have already been used. Please try again.");
        }
        res.status(500).send("Auth Error");
    }
});

module.exports = router;