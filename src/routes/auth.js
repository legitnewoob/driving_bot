const express = require('express');
const { newClient } = require('../config/google');
const Instructor = require('../models/instructorSchema');
const { invalidateInstructorCache } = require('../models/instructorModel');
const { readState } = require('../utils/oauthState');
const logger = require('../utils/logger-advanced');

const router = express.Router();

const dashboardUrl = () => process.env.DASHBOARD_URL || process.env.FRONTEND_URL || 'http://localhost:8080';

/**
 * GET /auth/google
 *
 * The old way to connect a calendar (by phone number, with no sign-in) is gone:
 * anyone could have attached their own Google Calendar to someone else's
 * account. Instructors connect from their dashboard instead.
 */
router.get('/google', (req, res) => {
    res.redirect(`${dashboardUrl()}/dashboard`);
});

/**
 * GET /auth/oauth2callback
 *
 * Google redirects here after an instructor connects their calendar from the
 * dashboard. `state` is the signed, short-lived value from /api/auth/calendar/connect,
 * which says which instructor started it; anything else is refused.
 */
router.get('/oauth2callback', async (req, res) => {
    try {
        const instructorId = readState(req.query.state);
        if (!instructorId) {
            logger.warn("OAuth callback with a missing, expired or forged state: ignored");
            return res.redirect(`${dashboardUrl()}/dashboard?calendar=error&reason=expired`);
        }
        if (req.query.error || !req.query.code) {
            return res.redirect(`${dashboardUrl()}/dashboard?calendar=error&reason=${encodeURIComponent(String(req.query.error || 'cancelled').slice(0, 40))}`);
        }

        const instructor = await Instructor.findOne({ _id: instructorId, active: true });
        if (!instructor) {
            logger.warn(`OAuth callback: instructor ${instructorId} not found`);
            return res.redirect(`${dashboardUrl()}/dashboard?calendar=error&reason=not_found`);
        }

        // A client of its own: never share credentials between requests
        const { tokens } = await newClient().getToken(String(req.query.code));

        // Store the refresh token and clear any expiry flag
        if (tokens.refresh_token) {
            instructor.googleRefreshToken = tokens.refresh_token;
            logger.info(`Refresh token updated for instructor ${instructor._id}`);
        } else {
            // Google only returns refresh_token on first consent; the one we have still works
            logger.warn(`OAuth callback for ${instructor._id}: no refresh_token (already stored or re-consent not triggered)`);
        }
        instructor.calendarTokenExpired = false;
        await instructor.save();
        invalidateInstructorCache(instructor.phoneNumberId);

        return res.redirect(`${dashboardUrl()}/dashboard?calendar=connected`);
    } catch (err) {
        logger.error(`OAuth callback error: ${err.message}`);
        return res.redirect(`${dashboardUrl()}/dashboard?calendar=error&reason=failed`);
    }
});

module.exports = router;
