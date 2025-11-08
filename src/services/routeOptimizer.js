const dotenv = require("dotenv");
const haversine = require("../utils/haversine.js");
const Booking = require("../models/bookingModel.js");
const User = require("../models/userModel.js");

dotenv.config();

class RouteOptimizer {
  constructor() {
    this.LATITUDE_DEFAULT =
      parseFloat(process.env.LATITUDE_DEFAULT) || 53.0168046;
    this.LONGITUDE_DEFAULT =
      parseFloat(process.env.LONGITUDE_DEFAULT) || -2.2190649;
    
    // 🗺️ Distance zones (in km)
    this.ZONES = [
      { name: "CLOSE", maxDistance: 5, timeRange: { start: "09:00", end: "11:59" } },
      { name: "MID", maxDistance: 10, timeRange: { start: "12:00", end: "14:59" } },
      { name: "FAR", maxDistance: 15, timeRange: { start: "15:00", end: "17:59" } },
      { name: "VERY_FAR", maxDistance: Infinity, timeRange: { start: "18:00", end: "23:59" } }
    ];
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
   * Checks if a time falls within a time range
   * @param {string} time - Time to check
   * @param {object} timeRange - Object with start and end times
   * @returns {boolean}
   */
  isTimeInRange(time, timeRange) {
    const timeMinutes = this.timeToMinutes(time);
    const startMinutes = this.timeToMinutes(timeRange.start);
    const endMinutes = this.timeToMinutes(timeRange.end);
    return timeMinutes >= startMinutes && timeMinutes <= endMinutes;
  }

  /**
   * Determines which zone a user belongs to based on their distance
   * @param {number} distance - Distance in km
   * @returns {object} Zone object
   */
  getUserZone(distance) {
    return this.ZONES.find(zone => distance <= zone.maxDistance);
  }

  async filterAvailableSlotsByLocation(
    availableSlotsForDate,
    dateRequested,
    instructorId,
    userPhone
  ) {
    try {
      // 🧍 Get user info
      const user = await User.findOne({ phone: userPhone });
      if (!user?.location?.latitude || !user?.location?.longitude) {
        console.warn(`⚠️ User location not found for ${userPhone}, returning all slots.`);
        return availableSlotsForDate;
      }

      const userLocation = {
        lat: user.location.latitude,
        long: user.location.longitude,
      };

      // 📅 Get all EXISTING bookings for that date
      const bookingsForDate = await Booking.find({ 
        date: dateRequested, 
        instructorId 
      });

      // 🏠 Instructor's home base
      const instructorBase = {
        lat: this.LATITUDE_DEFAULT,
        long: this.LONGITUDE_DEFAULT,
      };

      console.log(`\n📊 Filtering slots for date: ${dateRequested}`);
      console.log(`👤 User location: (${userLocation.lat.toFixed(4)}, ${userLocation.long.toFixed(4)})`);
      console.log(`🏠 Instructor base: (${instructorBase.lat.toFixed(4)}, ${instructorBase.long.toFixed(4)})`);
      console.log(`📅 Existing bookings: ${bookingsForDate.length}`);
      console.log(`🕒 Available slots: ${availableSlotsForDate.length}\n`);

      // 🗺️ Find nearest reference point (existing booking or base)
      let referencePoint = instructorBase;
      let minDistance = haversine(
        userLocation.lat,
        userLocation.long,
        instructorBase.lat,
        instructorBase.long
      );
      let referenceType = "instructor base";

      // Check distance to all existing bookings
      bookingsForDate.forEach((booking) => {
        const distance = haversine(
          userLocation.lat,
          userLocation.long,
          booking.location.latitude,
          booking.location.longitude
        );

        if (distance < minDistance) {
          minDistance = distance;
          referencePoint = booking.location;
          referenceType = `existing booking at ${booking.time}`;
        }
      });

      console.log(`📍 User is ${minDistance.toFixed(2)}km from nearest point (${referenceType})`);

      // 🎯 Determine user's zone
      const userZone = this.getUserZone(minDistance);
      console.log(`🗺️ User assigned to zone: ${userZone.name} (${userZone.timeRange.start}-${userZone.timeRange.end})\n`);

      // 🕒 Filter slots that match the user's zone time range
      const filteredSlots = availableSlotsForDate.filter((slotTime) => {
        const inRange = this.isTimeInRange(slotTime, userZone.timeRange);
        console.log(`  ${slotTime}: ${inRange ? '✅ AVAILABLE' : '❌ filtered'} (${userZone.name} zone)`);
        return inRange;
      });

      // 📌 If no slots available in their zone, offer the LAST available slot as fallback
      if (filteredSlots.length === 0 && availableSlotsForDate.length > 0) {
        const lastSlot = availableSlotsForDate[availableSlotsForDate.length - 1];
        console.log(`\n⚠️ No slots in ${userZone.name} zone - offering last slot as fallback: ${lastSlot}`);
        filteredSlots.push(lastSlot);
      }

      console.log(`\n✅ Final result: ${filteredSlots.length} slot(s) available\n`);
      return filteredSlots;
      
    } catch (error) {
      console.error("❌ Error filtering available slots:", error);
      return availableSlotsForDate; // Return unfiltered on error
    }
  }
}

module.exports = RouteOptimizer;