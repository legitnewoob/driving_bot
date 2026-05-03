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
   * Returns true if a booking has valid lat/long data
   * @param {object} booking - Mongoose booking document
   * @returns {boolean}
   */
  hasValidLocation(booking) {
    return (
      booking.location &&
      typeof booking.location.latitude === "number" &&
      !isNaN(booking.location.latitude) &&
      typeof booking.location.longitude === "number" &&
      !isNaN(booking.location.longitude)
    );
  }

  /**
   * Scores each available slot based on driving time to existing bookings.
   *
   * Strategy:
   *  - Uses Google Distance Matrix API for real driving durations.
   *  - Falls back to haversine (straight-line) if API is unavailable.
   *  - For every available slot we look at the bookings immediately before
   *    and after it (by time).
   *  - We compute the driving time the instructor would need to reach the
   *    new user's location from those neighbouring bookings.
   *  - Slots where the instructor is already nearby score highest.
   *  - If there are no bookings yet, slots are scored by driving time from
   *    the instructor's home base.
   *
   * @param {string[]} availableSlots - e.g. ["09:00","10:00","15:00"]
   * @param {object[]} bookings - existing confirmed bookings with location
   * @param {{lat:number, long:number}} userLocation
   * @param {{lat:number, long:number}} instructorBase
   * @returns {Promise<{slot:string, score:number}[]>} slots sorted best-first
   */
  async scoreSlots(availableSlots, bookings, userLocation, instructorBase) {
    // Build a timeline: bookings sorted by time
    const timeline = bookings
      .filter((b) => this.hasValidLocation(b))
      .map((b) => ({
        time: b.time,
        minutes: this.timeToMinutes(b.time),
        lat: b.location.latitude,
        long: b.location.longitude,
      }))
      .sort((a, b) => a.minutes - b.minutes);

    // Batch all destinations for a single Distance Matrix call:
    // [instructorBase, ...each booking location]
    const allDestinations = [
      { lat: instructorBase.lat, lng: instructorBase.long },
      ...timeline.map((t) => ({ lat: t.lat, lng: t.long })),
    ];

    const durations = await getDrivingDurations(
      userLocation.lat,
      userLocation.long,
      allDestinations
    );

    // durations[0] = user → instructor base
    // durations[1..n] = user → each timeline booking (in timeline order)
    const durationFromBase = durations[0];
    const haversineFromBase = haversine(
      userLocation.lat,
      userLocation.long,
      instructorBase.lat,
      instructorBase.long
    );
    // Use API duration if available, else estimate from haversine
    const travelFromBase = durationFromBase ?? (haversineFromBase * KM_TO_MIN_FACTOR);

    // Map each timeline entry to its driving duration
    const timelineDurations = timeline.map((t, idx) => {
      const apiDur = durations[idx + 1]; // offset by 1 (base is at index 0)
      if (apiDur !== null && apiDur !== undefined) return apiDur;
      // Fallback: haversine estimate
      return haversine(userLocation.lat, userLocation.long, t.lat, t.long) * KM_TO_MIN_FACTOR;
    });

    return availableSlots
      .map((slot) => {
        const slotMin = this.timeToMinutes(slot);

        // If no bookings with locations exist, score purely on base travel time
        if (timeline.length === 0) {
          const score = 1 / (1 + travelFromBase);
          return { slot, score, travelMin: travelFromBase, reason: `${travelFromBase.toFixed(0)}min from base` };
        }

        // Find the closest booking BEFORE and AFTER this slot
        let prevIdx = -1;
        let nextIdx = -1;
        for (let i = 0; i < timeline.length; i++) {
          if (timeline[i].minutes <= slotMin) prevIdx = i;
          if (timeline[i].minutes > slotMin && nextIdx === -1) nextIdx = i;
        }

        // Reference point = the booking the instructor would travel FROM
        const refIdx = prevIdx >= 0 ? prevIdx : nextIdx;
        const ref = timeline[refIdx];
        const travelFromRef = timelineDurations[refIdx];

        // Time gap penalty: prefer slots close in time to neighbouring bookings
        const gapMinutes = prevIdx >= 0
          ? slotMin - timeline[prevIdx].minutes
          : nextIdx >= 0
          ? timeline[nextIdx].minutes - slotMin
          : 480; // 8h fallback

        // Combined score: low travel time + low gap = high score
        const score = 1 / (1 + travelFromRef) * (1 / (1 + gapMinutes / 60));
        return {
          slot,
          score,
          travelMin: travelFromRef,
          reason: `${travelFromRef.toFixed(0)}min from ${ref.time} booking, ${gapMinutes}min gap`,
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
   * @returns {string[]} filtered/ranked slot times
   */
  async filterAvailableSlotsByLocation(
    availableSlotsForDate,
    dateRequested,
    instructor,
    userPhone
  ) {
    try {
      if (!availableSlotsForDate || availableSlotsForDate.length === 0) {
        return availableSlotsForDate;
      }

      // Get user info
      const user = await User.findOne({ phone: userPhone });
      if (!user?.location?.latitude || !user?.location?.longitude) {
        logger.warn(`User location not found for ${userPhone}, returning all slots`);
        return availableSlotsForDate;
      }

      const userLocation = {
        lat: user.location.latitude,
        long: user.location.longitude,
      };

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
      if (!this.hasValidLocation(booking)) continue;
      const dist = haversine(
        userLocation.lat,
        userLocation.long,
        booking.location.latitude,
        booking.location.longitude
      );
      if (dist < minDist) minDist = dist;
    }

    return minDist;
  }
}

module.exports = new RouteOptimizer();