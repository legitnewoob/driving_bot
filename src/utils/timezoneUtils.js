// utils/timezoneUtils.js
const moment = require('moment-timezone');

class TimezoneUtils {
  constructor() {
    // Get timezone from environment or default to Asia/Kolkata
    this.timezone = process.env.APP_TIMEZONE || 'Asia/Kolkata';
    console.log(`🌍 Using timezone: ${this.timezone}`);
  }

  /**
   * Get current date in the configured timezone
   * @returns {Date} Current date in timezone
   */
  getCurrentDate() {
    return moment.tz(this.timezone).toDate();
  }

  /**
   * Get current date string in YYYY-MM-DD format
   * @returns {string} Current date string
   */
  getCurrentDateString() {
    return moment.tz(this.timezone).format('YYYY-MM-DD');
  }

  /**
   * Get current time in HH:MM format
   * @returns {string} Current time string
   */
  getCurrentTimeString() {
    return moment.tz(this.timezone).format('HH:mm');
  }

  /**
   * Convert a date to the configured timezone
   * @param {Date|string} date - Date to convert
   * @returns {Date} Date in configured timezone
   */
  toTimezone(date) {
    return moment.tz(date, this.timezone).toDate();
  }

  /**
   * Create a date in the configured timezone
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @param {string} timeStr - Time string in HH:MM format (optional)
   * @returns {Date} Date object in configured timezone
   */
  createDateInTimezone(dateStr, timeStr = '00:00') {
    return moment.tz(`${dateStr} ${timeStr}`, 'YYYY-MM-DD HH:mm', this.timezone).toDate();
  }

  /**
   * Format a date for display in the configured timezone
   * @param {Date|string} date - Date to format
   * @param {string} format - Moment.js format string
   * @returns {string} Formatted date string
   */
  formatDate(date, format = 'YYYY-MM-DD HH:mm') {
    return moment.tz(date, this.timezone).format(format);
  }

  /**
   * Check if a date is within 24 hours from now (in configured timezone)
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @param {string} timeStr - Time in HH:MM format
   * @returns {boolean} True if within 24 hours
   */
  isWithin24Hours(dateStr, timeStr = '00:00') {
    const now = moment.tz(this.timezone);
    const requestedDateTime = moment.tz(`${dateStr} ${timeStr}`, 'YYYY-MM-DD HH:mm', this.timezone);
    
    const hoursUntil = requestedDateTime.diff(now, 'hours', true);
    return hoursUntil < 24;
  }

  /**
   * Check if a date is a weekend in the configured timezone
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @returns {boolean} True if weekend
   */
  isWeekend(dateStr) {
    const date = moment.tz(dateStr, 'YYYY-MM-DD', this.timezone);
    const dayOfWeek = date.day();
    return dayOfWeek === 0 || dayOfWeek === 6; // Sunday = 0, Saturday = 6
  }

  /**
   * Get day name for a date in the configured timezone
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @returns {string} Day name (e.g., 'Monday')
   */
  getDayName(dateStr) {
    return moment.tz(dateStr, 'YYYY-MM-DD', this.timezone).format('dddd');
  }

  /**
   * Get tomorrow's date in YYYY-MM-DD format
   * @returns {string} Tomorrow's date
   */
  getTomorrowDateString() {
    return moment.tz(this.timezone).add(1, 'day').format('YYYY-MM-DD');
  }

  /**
   * Get yesterday's date in YYYY-MM-DD format
   * @returns {string} Yesterday's date
   */
  getYesterdayDateString() {
    return moment.tz(this.timezone).subtract(1, 'day').format('YYYY-MM-DD');
  }

  /**
   * Add days to a date and return in YYYY-MM-DD format
   * @param {string} dateStr - Starting date in YYYY-MM-DD format
   * @param {number} days - Number of days to add
   * @returns {string} New date string
   */
  addDays(dateStr, days) {
    return moment.tz(dateStr, 'YYYY-MM-DD', this.timezone)
      .add(days, 'days')
      .format('YYYY-MM-DD');
  }

  /**
   * Check if a given date is today in the configured timezone
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @returns {boolean} True if today
   */
  isToday(dateStr) {
    return dateStr === this.getCurrentDateString();
  }

  /**
   * Check if a given date is tomorrow in the configured timezone
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @returns {boolean} True if tomorrow
   */
  isTomorrow(dateStr) {
    return dateStr === this.getTomorrowDateString();
  }

  /**
   * Get the current day number in the configured timezone
   * @returns {number} Current day of month
   */
  getCurrentDay() {
    return moment.tz(this.timezone).date();
  }

  /**
   * Calculate next occurrence of a day number
   * @param {number} dayNumber - Day of month (1-31)
   * @returns {string} Date in YYYY-MM-DD format
   */
  getNextOccurrenceOfDay(dayNumber) {
    const today = moment.tz(this.timezone);
    const currentDay = today.date();
    
    let targetDate = today.clone();
    
    if (dayNumber <= currentDay) {
      // Move to next month
      targetDate = targetDate.add(1, 'month').date(dayNumber);
    } else {
      // Use current month
      targetDate = targetDate.date(dayNumber);
    }
    
    return targetDate.format('YYYY-MM-DD');
  }
}

module.exports = new TimezoneUtils();