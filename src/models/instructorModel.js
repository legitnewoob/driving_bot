const timezoneUtils = require("../utils/timezoneUtils");
const Instructor = require("./instructorSchema");
const logger = require("../utils/logger-advanced");

// ── In-memory session store (per-user conversation state) ─────────────
const userSessions = {};

function getUserSession(phone) {
    if (!userSessions[phone]) {
        userSessions[phone] = {
            conversationHistory: [],
            lastActivity: timezoneUtils.getCurrentDate()
        };
    }
    return userSessions[phone];
}

function updateUserSession(phone, session) {
    session.lastActivity = timezoneUtils.getCurrentDate();
    userSessions[phone] = session;
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

// ── Available dates (next 90 weekdays) ────────────────────────────────

function getAvailableDates() {
    const dates = [];
    const today = timezoneUtils.getCurrentDate(); // gets current date in IST
    
    // Create today's date at midnight (local)
    const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    for (let i = 1; i <= 90; i++) {
        const date = new Date(todayLocal);
        date.setDate(todayLocal.getDate() + i);

        const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            dates.push(`${year}-${month}-${day}`);
        }
    }

    return dates;
}


module.exports = {
    userSessions,
    getUserSession,
    updateUserSession,
    getInstructor,
    invalidateInstructorCache,
    getAvailableDates
};