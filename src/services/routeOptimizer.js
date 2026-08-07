const haversine = require("../utils/haversine.js");
const Booking = require("../models/bookingModel.js");
const User = require("../models/userModel.js");
const logger = require("../utils/logger-advanced.js");
const { getDrivingDurations } = require("./distanceMatrixService.js");

// Rough conversion: 1 km ≈ 2 min driving in urban areas (used as fallback)
const KM_TO_MIN_FACTOR = 2;

class RouteOptimizer {
  constructor() {
    // Max driving-time (minutes) before we consider it "far"
    this.NEARBY_THRESHOLD_MIN = 20;
  }

  /**
   * Converts time string to minutes for comparison
   * @param {string} time - Time in format "HH:MM"
   * @returns {number} Minutes since midnight
   */
  timeToMinutes(time) {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Returns true if a location object has finite numeric lat/long.
   */
  _isValidLoc(loc) {
    return (
      loc &&
      typeof loc.latitude === "number" &&
      !isNaN(loc.latitude) &&
      typeof loc.longitude === "number" &&
      !isNaN(loc.longitude)
    );
  }

  /**
   * Returns the first valid location from a list, or null if none are valid.
   * Used to pick the best available coordinate from
   * pickupLocation / dropoffLocation / legacy `location` fields.
   */
  _pickLoc(...candidates) {
    for (const c of candidates) {
      if (this._isValidLoc(c)) return c;
    }
    return null;
  }

  /**
   * Returns true if a booking has any usable lat/long data
   * (pickup, drop-off, or legacy `location`).
   */
  hasValidLocation(booking) {
    return (
      this._isValidLoc(booking.pickupLocation) ||
      this._isValidLoc(booking.dropoffLocation) ||
      this._isValidLoc(booking.location)
    );
  }

  /**
   * Scores each available slot based on driving time to existing bookings.
   *
   * Strategy:
   *  - For each existing booking we know two coordinates:
   *      • `start` — where the instructor begins it (pickup if available,
   *                  otherwise drop-off, otherwise legacy `location`)
   *      • `end`   — where the instructor ends it   (drop-off if available,
   *                  otherwise pickup,  otherwise legacy `location`)
   *  - When a candidate slot has a PREVIOUS booking, the instructor must
   *    travel from that booking's `end` → the candidate user.
   *  - When a candidate slot has a NEXT booking, the instructor must travel
   *    from the candidate user → that booking's `start`.
   *  - Uses Google Distance Matrix for real durations, haversine fallback.
   *  - Slots where the instructor is already nearby score highest.
   *  - If there are no bookings yet, slots are scored by driving time from
   *    the instructor's home base.
   *
   * @param {string[]} availableSlots - e.g. ["09:00","10:00","15:00"]
   * @param {object[]} bookings - existing confirmed bookings
   * @param {{lat:number, long:number}} userLocation - candidate user pickup
   *                  (or profile location if real pickup not yet known)
   * @param {{lat:number, long:number}} instructorBase
   * @returns {Promise<{slot:string, score:number}[]>} slots sorted best-first
   */
  async scoreSlots(availableSlots, bookings, userLocation, instructorBase) {
    // Build a timeline: bookings sorted by time, with explicit start/end points
    const timeline = bookings
      .filter((b) => this.hasValidLocation(b))
      .map((b) => {
        // Instructor STARTS at pickup, ENDS at drop-off — fall back as needed
        const start = this._pickLoc(b.pickupLocation, b.dropoffLocation, b.location);
        const end = this._pickLoc(b.dropoffLocation, b.pickupLocation, b.location);
        return {
          time: b.time,
          minutes: this.timeToMinutes(b.time),
          startLat: start.latitude,
          startLng: start.longitude,
          endLat: end.latitude,
          endLng: end.longitude,
        };
      })
      .sort((a, b) => a.minutes - b.minutes);

    const n = timeline.length;

    // Batch destinations for ONE Distance Matrix call:
    //   [0]                = instructorBase
    //   [1 .. n]           = each booking's END  (for "prev → user" trips)
    //   [n+1 .. 2n]        = each booking's START (for "user → next" trips)
    const allDestinations = [
      { lat: instructorBase.lat, lng: instructorBase.long },
      ...timeline.map((t) => ({ lat: t.endLat, lng: t.endLng })),
      ...timeline.map((t) => ({ lat: t.startLat, lng: t.startLng })),
    ];

    const durations = await getDrivingDurations(
      userLocation.lat,
      userLocation.long,
      allDestinations
    );

    const durationFromBase = durations[0];
    const haversineFromBase = haversine(
      userLocation.lat,
      userLocation.long,
      instructorBase.lat,
      instructorBase.long
    );
    const travelFromBase = durationFromBase ?? (haversineFromBase * KM_TO_MIN_FACTOR);

    // Travel time when the booking is the PREV one (instructor leaves its end → user)
    const travelFromPrev = timeline.map((t, idx) => {
      const apiDur = durations[1 + idx];
      if (apiDur !== null && apiDur !== undefined) return apiDur;
      return haversine(userLocation.lat, userLocation.long, t.endLat, t.endLng) * KM_TO_MIN_FACTOR;
    });

    // Travel time when the booking is the NEXT one (user → its start)
    const travelToNext = timeline.map((t, idx) => {
      const apiDur = durations[1 + n + idx];
      if (apiDur !== null && apiDur !== undefined) return apiDur;
      return haversine(userLocation.lat, userLocation.long, t.startLat, t.startLng) * KM_TO_MIN_FACTOR;
    });

    return availableSlots
      .map((slot) => {
        const slotMin = this.timeToMinutes(slot);

        // No bookings with locations: score purely on base travel time
        if (n === 0) {
          const score = 1 / (1 + travelFromBase);
          return { slot, score, travelMin: travelFromBase, reason: `${travelFromBase.toFixed(0)}min from base` };
        }

        // Find the closest booking BEFORE and AFTER this slot
        let prevIdx = -1;
        let nextIdx = -1;
        for (let i = 0; i < n; i++) {
          if (timeline[i].minutes <= slotMin) prevIdx = i;
          if (timeline[i].minutes > slotMin && nextIdx === -1) nextIdx = i;
        }

        // Pick the right neighbour and the right travel direction.
        // Prefer prev (instructor's actual sequence: prev → user).
        let refIdx;
        let travelFromRef;
        let refSide;
        if (prevIdx >= 0) {
          refIdx = prevIdx;
          travelFromRef = travelFromPrev[prevIdx];
          refSide = "after";
        } else {
          refIdx = nextIdx;
          travelFromRef = travelToNext[nextIdx];
          refSide = "before";
        }

        const ref = timeline[refIdx];

        // Time gap penalty: prefer slots close in time to neighbouring bookings
        const gapMinutes = prevIdx >= 0
          ? slotMin - timeline[prevIdx].minutes
          : nextIdx >= 0
          ? timeline[nextIdx].minutes - slotMin
          : 480;

        // Combined score: low travel time + low gap = high score
        const score = 1 / (1 + travelFromRef) * (1 / (1 + gapMinutes / 60));
        return {
          slot,
          score,
          travelMin: travelFromRef,
          reason: `${travelFromRef.toFixed(0)}min ${refSide} ${ref.time} booking, ${gapMinutes}min gap`,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Filters and ranks available time slots based on the user's location
   * relative to existing bookings for that day.
   *
   * Uses Google Distance Matrix API for real driving durations.
   * Falls back to haversine if the API is unavailable.
   *
   * @param {string[]} availableSlotsForDate - e.g. ["09:00","10:00","15:00"]
   * @param {string} dateRequested - "YYYY-MM-DD"
   * @param {object} instructor - Instructor object with baseLocation
   * @param {string} userPhone
   * @param {object} [userLocationOverride] - Optional override for user location
   * @returns {string[]} filtered/ranked slot times
   */
  async filterAvailableSlotsByLocation(
    availableSlotsForDate,
    dateRequested,
    instructor,
    userPhone,
    userLocationOverride = null
  ) {
    try {
      if (!availableSlotsForDate || availableSlotsForDate.length === 0) {
        return availableSlotsForDate;
      }

      // Prefer the explicit override (e.g. real pickup coordinates from the
      // current conversation) when supplied; fall back to the user's profile
      // location otherwise.
      let userLocation = null;
      if (
        userLocationOverride &&
        typeof userLocationOverride.lat === "number" &&
        typeof userLocationOverride.long === "number"
      ) {
        userLocation = {
          lat: userLocationOverride.lat,
          long: userLocationOverride.long,
        };
        logger.info(
          `Route optimiser: using userLocationOverride (${userLocation.lat.toFixed(4)},${userLocation.long.toFixed(4)})`
        );
      } else {
        const user = await User.findOne({ phone: userPhone });
        if (!user?.location?.latitude || !user?.location?.longitude) {
          logger.warn(`User location not found for ${userPhone}, returning all slots`);
          return availableSlotsForDate;
        }
        userLocation = {
          lat: user.location.latitude,
          long: user.location.longitude,
        };
      }

      // Get CONFIRMED bookings for that date (ignore cancelled ones)
      const instructorId = instructor?.phoneNumberId || instructor;
      const bookingsForDate = await Booking.find({
        date: dateRequested,
        instructorId,
        status: { $in: ["confirmed", "rescheduled"] },
      });

      // Instructor's home base (from DB record)
      const instructorBase = {
        lat: instructor?.baseLocation?.latitude || 53.0168046,
        long: instructor?.baseLocation?.longitude || -2.2190649,
      };

      logger.info(
        `Route optimiser: date=${dateRequested}, user=(${userLocation.lat.toFixed(4)},${userLocation.long.toFixed(4)}), ` +
        `bookings=${bookingsForDate.length}, slots=${availableSlotsForDate.length}`
      );

      // Score every available slot (uses Distance Matrix API with haversine fallback)
      const scored = await this.scoreSlots(
        availableSlotsForDate,
        bookingsForDate,
        userLocation,
        instructorBase
      );

      // Keep only slots where travel time is within threshold,
      // OR if that yields nothing, return the top-3 best-scored slots.
      const nearbySlots = scored.filter((s) => s.travelMin <= this.NEARBY_THRESHOLD_MIN);

      let result;
      if (nearbySlots.length > 0) {
        result = nearbySlots.map((s) => s.slot);
        logger.info(`Route optimiser: ${result.length} slot(s) within ${this.NEARBY_THRESHOLD_MIN}min threshold`);
      } else {
        // Fallback: return top-3 best-scored slots so user always has options
        result = scored.slice(0, 3).map((s) => s.slot);
        logger.info(`Route optimiser: no slots within threshold, offering top ${result.length} by score`);
      }

      // Preserve chronological order for the user
      result.sort((a, b) => this.timeToMinutes(a) - this.timeToMinutes(b));

      logger.info(`Route optimiser result: [${result.join(", ")}]`);
      return result;
    } catch (error) {
      logger.error(`Route optimiser error: ${error.message}`);
      return availableSlotsForDate; // Return unfiltered on error
    }
  }

  /**
   * Returns the haversine distance (km) from the user to the nearest
   * reference point (neighbouring booking or instructor base).
   * This is a lightweight synchronous helper used outside the main scoring path.
   */
  getNearestReferenceDistance(slotTime, bookings, userLocation, instructorBase) {
    let minDist = haversine(
      userLocation.lat,
      userLocation.long,
      instructorBase.lat,
      instructorBase.long
    );

    for (const booking of bookings) {
      const loc = this._pickLoc(
        booking.pickupLocation,
        booking.dropoffLocation,
        booking.location
      );
      if (!loc) continue;
      const dist = haversine(
        userLocation.lat,
        userLocation.long,
        loc.latitude,
        loc.longitude
      );
      if (dist < minDist) minDist = dist;
    }

    return minDist;
  }
}

module.exports = new RouteOptimizer();