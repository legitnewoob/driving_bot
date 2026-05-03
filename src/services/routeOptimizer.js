const haversine = require("../utils/haversine.js");
const Booking = require("../models/bookingModel.js");
const User = require("../models/userModel.js");
const logger = require("../utils/logger-advanced.js");

class RouteOptimizer {
  constructor() {
    // Max km between consecutive bookings before we consider it "far"
    this.NEARBY_THRESHOLD_KM = 8;
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
   * Scores each available slot based on proximity to existing bookings.
   *
   * Strategy:
   *  - For every available slot we look at the bookings immediately before
   *    and after it (by time).
   *  - We compute the detour the instructor would need to travel to reach the
   *    new user's location from those neighbouring bookings.
   *  - Slots where the instructor is already nearby score highest.
   *  - If there are no bookings yet, slots are scored by distance from the
   *    instructor's home base (closer users get earlier slots).
   *
   * @param {string[]} availableSlots - e.g. ["09:00","10:00","15:00"]
   * @param {object[]} bookings - existing confirmed bookings with location
   * @param {{lat:number, long:number}} userLocation
   * @param {{lat:number, long:number}} instructorBase
   * @returns {{slot:string, score:number}[]} slots sorted best-first
   */
  scoreSlots(availableSlots, bookings, userLocation, instructorBase) {
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

    const distFromBase = haversine(
      userLocation.lat,
      userLocation.long,
      instructorBase.lat,
      instructorBase.long
    );

    return availableSlots
      .map((slot) => {
        const slotMin = this.timeToMinutes(slot);

        // If no bookings with locations exist, score purely on base distance
        if (timeline.length === 0) {
          // Lower distance → higher score (invert)
          const score = 1 / (1 + distFromBase);
          return { slot, score, reason: `${distFromBase.toFixed(1)}km from base` };
        }

        // Find the closest booking BEFORE and AFTER this slot
        let prev = null;
        let next = null;
        for (const entry of timeline) {
          if (entry.minutes <= slotMin) prev = entry;
          if (entry.minutes > slotMin && !next) next = entry;
        }

        // Reference point = the booking the instructor would travel FROM
        const ref = prev || next;
        const distFromRef = haversine(
          userLocation.lat,
          userLocation.long,
          ref.lat,
          ref.long
        );

        // Time gap penalty: prefer slots close in time to neighbouring bookings
        const gapMinutes = prev
          ? slotMin - prev.minutes
          : next
          ? next.minutes - slotMin
          : 480; // 8h fallback

        // Combined score: low distance + low gap = high score
        const score = 1 / (1 + distFromRef) * (1 / (1 + gapMinutes / 60));
        return {
          slot,
          score,
          reason: `${distFromRef.toFixed(1)}km from ${ref.time} booking, ${gapMinutes}min gap`,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Filters and ranks available time slots based on the user's location
   * relative to existing bookings for that day.
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

      // Score every available slot
      const scored = this.scoreSlots(
        availableSlotsForDate,
        bookingsForDate,
        userLocation,
        instructorBase
      );

      // Keep only slots where the instructor detour is within threshold,
      // OR if that yields nothing, return the top-3 best-scored slots.
      const distFromBase = haversine(
        userLocation.lat,
        userLocation.long,
        instructorBase.lat,
        instructorBase.long
      );

      const nearbySlots = scored.filter((s) => {
        // Re-derive distance for the threshold check
        const ref = this.getNearestReferenceDistance(
          s.slot,
          bookingsForDate,
          userLocation,
          instructorBase
        );
        return ref <= this.NEARBY_THRESHOLD_KM;
      });

      let result;
      if (nearbySlots.length > 0) {
        result = nearbySlots.map((s) => s.slot);
        logger.info(`Route optimiser: ${result.length} slot(s) within ${this.NEARBY_THRESHOLD_KM}km threshold`);
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
   * Returns the distance (km) from the user to the nearest reference point
   * (neighbouring booking or instructor base) for a given slot time.
   */
  getNearestReferenceDistance(slotTime, bookings, userLocation, instructorBase) {
    const slotMin = this.timeToMinutes(slotTime);
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