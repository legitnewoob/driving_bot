const timezoneUtils = require("../utils/timezoneUtils");
const Instructor = require("./instructorSchema");
const logger = require("../utils/logger-advanced");

// ── In-memory session store (per-user conversation state) ─────────────
const userSessions = {};

function getUserSession(phone, instructorPhoneId) {
    const key = instructorPhoneId ? `${phone}::${instructorPhoneId}` : phone;
    if (!userSessions[key]) {
        userSessions[key] = {
            conversationHistory: [],
            lastActivity: timezoneUtils.getCurrentDate()
        };
    }
    return userSessions[key];
}

function updateUserSession(phone, session, instructorPhoneId) {
    const key = instructorPhoneId ? `${phone}::${instructorPhoneId}` : phone;
    session.lastActivity = timezoneUtils.getCurrentDate();
    userSessions[key] = session;
}

// ── Instructor lookup (DB-backed) ─────────────────────────────────────

// In-memory cache to avoid hitting DB on every message.
// Maps phoneNumberId → instructor document.
const _instructorCache = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch an instructor from DB (with cache).
 * @param {string} phoneNumberId - The WhatsApp phone_number_id
 * @returns {Promise<Object|null>} Instructor document or null
 */
async function getInstructor(phoneNumberId) {
    const cached = _instructorCache[phoneNumberId];
    if (cached && Date.now() - cached._cachedAt < CACHE_TTL_MS) {
        return cached;
    }

    try {
        const instructor = await Instructor.findOne({ phoneNumberId, active: true }).lean();
        if (instructor) {
            instructor._cachedAt = Date.now();
            _instructorCache[phoneNumberId] = instructor;
        }
        return instructor;
    } catch (err) {
        logger.error(`Error fetching instructor ${phoneNumberId}: ${err.message}`);
        return cached || null; // return stale cache on DB error
    }
}

/**
 * Invalidate the cache for an instructor (e.g. after admin update).
 */
function invalidateInstructorCache(phoneNumberId) {
    delete _instructorCache[phoneNumberId];
}

// ── Bookable dates (working days within the booking window) ──────────

function getAvailableDates(instructor = {}) {
    const { bookableDates } = require("../services/instructorSettings");
    return bookableDates(instructor);
}


module.exports = {
    userSessions,
    getUserSession,
    updateUserSession,
    getInstructor,
    invalidateInstructorCache,
    getAvailableDates
};