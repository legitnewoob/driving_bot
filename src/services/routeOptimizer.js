const haversine = require("../utils/haversine.js");
const Booking = require("../models/bookingModel.js");
const User = require("../models/userModel.js");
const logger = require("../utils/logger-advanced.js");
const timezoneUtils = require("../utils/timezoneUtils");
const { getDrivingMatrix } = require("./distanceMatrixService.js");
const settings = require("./instructorSettings");
const dayPacker = require("./dayPacker");

// Rough conversion used when the Routes API has no answer: 1 km ≈ 2 min urban driving.
const KM_TO_MIN_FACTOR = 2;
const ADJACENT_GAP_MIN = 15;
const FALLBACK_OFFER_COUNT = 3;
const ACTIVE_STATUSES = ["confirmed", "rescheduled"];
const KM_PER_MILE = 1.609344;
const UK_POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}$/i;

function pointKey(p) {
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

function uniquePoints(points) {
  const seen = new Map();
  for (const p of points) if (p && !seen.has(pointKey(p))) seen.set(pointKey(p), p);
  return [...seen.values()];
}

class RouteOptimizer {
  timeToMinutes(time) {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  }

  _isValidLoc(loc) {
    return (
      loc &&
      typeof loc.latitude === "number" &&
      !isNaN(loc.latitude) &&
      typeof loc.longitude === "number" &&
      !isNaN(loc.longitude)
    );
  }

  _pickLoc(...candidates) {
    for (const c of candidates) {
      if (this._isValidLoc(c)) return c;
    }
    return null;
  }

  hasValidLocation(booking) {
    return (
      this._isValidLoc(booking.pickupLocation) ||
      this._isValidLoc(booking.dropoffLocation) ||
      this._isValidLoc(booking.location)
    );
  }

  _toPoint(loc) {
    if (!loc) return null;
    if (this._isValidLoc(loc)) return { lat: loc.latitude, lng: loc.longitude };
    const lat = loc.lat;
    const lng = loc.lng ?? loc.long;
    if (typeof lat === "number" && typeof lng === "number" && !isNaN(lat) && !isNaN(lng)) {
      return { lat, lng };
    }
    return null;
  }

  homePoint(instructor) {
    return this._toPoint(instructor?.baseLocation);
  }

  /**
   * The instructor's day as time-ordered stops. Each stop starts at its pickup
   * (or drop-off / legacy location) and ends at its drop-off (or pickup / legacy).
   * Stops with no usable location still block their time but count as zero travel.
   */
  buildDayPlan(bookings, route) {
    return bookings
      .filter((b) => typeof b.time === "string")
      .map((b) => {
        const startAt = this.timeToMinutes(b.time);
        const endAt = startAt + (b.durationMin || route.lessonDurationMin);
        return {
          kind: "lesson",
          label: b.time,
          startAt,
          endAt,
          start: startAt,
          end: endAt,
          startLoc: this._toPoint(this._pickLoc(b.pickupLocation, b.dropoffLocation, b.location)),
          endLoc: this._toPoint(this._pickLoc(b.dropoffLocation, b.pickupLocation, b.location)),
        };
      })
      .sort((a, b) => a.startAt - b.startAt);
  }

  /**
   * Returns travel(a, b) in minutes. One Routes matrix covers every leg a slot
   * evaluation can need: into the learner, out of the learner, and the existing
   * stop-to-stop legs. Missing elements fall back to straight-line estimates.
   */
  async buildTravel(plan, userPt, homePt, departureTime = null, userEndPt = null) {
    const origins = uniquePoints([userPt, userEndPt, homePt, ...plan.map((s) => s.endLoc)]);
    const destinations = uniquePoints([userPt, homePt, ...plan.map((s) => s.startLoc)]);

    let matrix = null;
    try {
      matrix = await getDrivingMatrix(origins, destinations, departureTime);
    } catch (err) {
      logger.warn(`Routes matrix unavailable, using straight-line estimates: ${err.message}`);
    }

    const oIdx = new Map(origins.map((p, i) => [pointKey(p), i]));
    const dIdx = new Map(destinations.map((p, i) => [pointKey(p), i]));

    // The Routes API's drive time, or null when it has none
    const exact = (a, b) => {
      if (!a || !b) return null;
      if (pointKey(a) === pointKey(b)) return 0;
      const i = oIdx.get(pointKey(a));
      const j = dIdx.get(pointKey(b));
      const api = matrix && i !== undefined && j !== undefined ? matrix[i]?.[j] : null;
      return api === null || api === undefined ? null : api;
    };
    const travel = (a, b) => {
      if (!a || !b) return 0;
      const api = exact(a, b);
      if (api !== null) return api;
      return haversine(a.lat, a.lng, b.lat, b.lng) * KM_TO_MIN_FACTOR;
    };
    travel.exact = exact;
    return travel;
  }

  /**
   * Packed mode: minutes to leave between two things in the day (see dayPacker),
   * or null when the drive is longer than the instructor's longest drive (H).
   * Real drive + variance when both ends have a location, else X. Blocks
   * (calendar events, breaks) have no location, so they always get X. A learner
   * who hasn't booked yet (UNKNOWN) is assumed to live near the instructor's base.
   */
  _packedGap(route, travel, userPt, userEndPt, homePt = null) {
    const X = route.bufferMin;
    const H = route.maxDriveMin;
    const V = route.driveVarianceMin;
    // limit: the longest drive allowed. The guess about a learner who hasn't
    // booked yet only sizes the gap, so it has no limit.
    const between = (from, to, limit = H) => {
      if (!travel || !from || !to) return X;
      const drive = travel.exact ? travel.exact(from, to) : travel(from, to);
      if (drive != null) return dayPacker.gapFor(drive, X, V, limit);
      // No Routes answer: go by the straight-line estimate, never below X
      const estimate = travel(from, to);
      if (estimate > limit) return null;
      return estimate > X ? dayPacker.roundUp5(estimate + V) : X;
    };
    const endOf = (it) => (it.isNew ? userEndPt : it.endLoc);
    const startOf = (it) => (it.isNew ? userPt : it.startLoc);
    return (a, b) => {
      if (a.isUnknown || b.isUnknown) {
        const other = a.isUnknown ? b : a;
        if (!other.isNew) return X;
        const g = a.isUnknown ? between(homePt, userPt, Infinity) : between(userEndPt, homePt, Infinity);
        return Math.max(X, g);
      }
      if ((!a.isNew && a.kind !== "lesson") || (!b.isNew && b.kind !== "lesson")) return X;
      return between(endOf(a), startOf(b));
    };
  }

  _isStranded(slotStart, slotEnd, before, after, direct, grace) {
    if (before.home || after.home) return false;
    const slack = slotStart - before.at + grace + (after.at - slotEnd + grace);
    return direct > slack;
  }

  /**
   * Scores one candidate slot by the driving it adds to the day
   * (cheapest insertion), whether the instructor can make it on time,
   * and how many other free slots it would leave unbookable.
   * Lower score is better.
   */
  scoreSlot(slot, plan, userPt, homePt, route, travel, freeSlots = [], opts = {}) {
    const duration = opts.durationMin || route.lessonDurationMin;
    const grace = route.travelGraceMin;
    const userEndPt = opts.userEndPt || userPt;
    const s = this.timeToMinutes(slot);
    const e = s + duration;

    const clash = plan.find((p) => s < p.endAt && e > p.startAt);
    if (clash) {
      return { slot, feasible: false, addedDrive: null, score: Infinity, reason: `overlaps your ${clash.label} lesson` };
    }

    let prev = null;
    let next = null;
    for (const p of plan) {
      if (p.endAt <= s) prev = p;
      if (p.startAt >= e && !next) next = p;
    }

    const before = prev
      ? { loc: prev.endLoc, at: prev.endAt, home: false, label: prev.label }
      : { loc: homePt, at: -Infinity, home: true };
    const after = next
      ? { loc: next.startLoc, at: next.startAt, home: false, label: next.label }
      : { loc: homePt, at: Infinity, home: true };

    const hw = route.homeLegWeight;
    const weight = (stop) => (stop.home ? hw : 1);
    const travelIn = travel(before.loc, userPt);
    const travelOut = travel(userEndPt, after.loc);
    const direct = travel(before.loc, after.loc);
    const directWeight = before.home || after.home ? hw : 1;
    const addedDrive = Math.max(
      0,
      weight(before) * travelIn + weight(after) * travelOut - directWeight * direct
    );

    let arriveOk = before.home || before.at + travelIn <= s + grace;
    let leaveOk = after.home || e + travelOut <= after.at + grace;

    // Packed mode: the drive plus the variance must fit in the gap, and in X
    if (route.packed) {
      const gap = this._packedGap(route, travel, userPt, userEndPt, homePt);
      const NEW = { isNew: true };
      const gIn = prev ? gap({ ...prev, kind: "lesson" }, NEW) : 0;
      const gOut = next ? gap(NEW, { ...next, kind: "lesson" }) : 0;
      if (prev && (gIn == null || prev.endAt + gIn > s)) {
        arriveOk = false;
      }
      if (next && (gOut == null || e + gOut > next.startAt)) {
        leaveOk = false;
      }
    }

    if (!arriveOk || !leaveOk) {
      const reason = !arriveOk
        ? `can't get there in time after your ${before.label} lesson (${Math.round(travelIn)} min drive)`
        : `couldn't reach your ${after.label} lesson in time afterwards (${Math.round(travelOut)} min drive)`;
      return { slot, feasible: false, addedDrive, travelIn, travelOut, score: Infinity, reason };
    }

    let newlyStranded = 0;
    if (route.fragmentationPenaltyMin > 0) {
      const lo = prev ? prev.endAt : -Infinity;
      const hi = next ? next.startAt : Infinity;
      const userStop = { loc: userPt, home: false };
      const userEndStop = { loc: userEndPt, home: false };
      for (const free of freeSlots) {
        if (free === slot) continue;
        const fs = this.timeToMinutes(free);
        const fe = fs + duration;
        if (fs < lo || fe > hi || (fs < e && fe > s)) continue;
        const wasStranded = this._isStranded(fs, fe, before, after, direct, grace);
        const isStranded = fs < s
          ? this._isStranded(fs, fe, before, { ...userStop, at: s }, travelIn, grace)
          : this._isStranded(fs, fe, { ...userEndStop, at: e }, after, travelOut, grace);
        if (isStranded && !wasStranded) newlyStranded++;
      }
    }

    const adjacent = !!(
      (prev && s - prev.endAt <= ADJACENT_GAP_MIN) ||
      (next && next.startAt - e <= ADJACENT_GAP_MIN)
    );

    const score =
      addedDrive +
      route.fragmentationPenaltyMin * newlyStranded -
      (adjacent ? route.adjacencyBonusMin : 0);

    const mins = Math.round(addedDrive);
    let reason;
    if (prev && next) reason = `+${mins} min drive, between your ${prev.label} and ${next.label} lessons`;
    else if (prev) reason = `+${mins} min drive, after your ${prev.label} lesson`;
    else if (next) reason = `+${mins} min drive, before your ${next.label} lesson`;
    else reason = homePt ? `+${mins} min drive from home` : "no other lessons that day";
    if (newlyStranded > 0) {
      reason += `; leaves ${newlyStranded} free slot${newlyStranded > 1 ? "s" : ""} hard to fill`;
    }

    return { slot, feasible: true, addedDrive, travelIn, travelOut, newlyStranded, adjacent, score, reason };
  }

  /**
   * Scores every slot for a day, best first. Infeasible slots sort last.
   * @param {string[]} availableSlots
   * @param {object[]} bookings - confirmed bookings that day
   * @param {{lat:number, long:number}} userLocation
   * @param {{lat:number, long:number}|null} instructorBase
   * @param {object} route - resolved route settings
   */
  async scoreSlots(availableSlots, bookings, userLocation, instructorBase, route, departureTime = null, opts = {}) {
    const userPt = this._toPoint(userLocation);
    const homePt = this._toPoint(instructorBase);
    const userEndPt = this._toPoint(opts.dropoffLoc) || null;
    const plan = this.buildDayPlan(bookings, route);
    const travel = opts.travel || (await this.buildTravel(plan, userPt, homePt, departureTime, userEndPt));
    const slotOpts = { durationMin: opts.durationMin, userEndPt };

    return availableSlots
      .map((slot) => this.scoreSlot(slot, plan, userPt, homePt, route, travel, availableSlots, slotOpts))
      .sort((a, b) => {
        if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
        return a.score - b.score;
      });
  }

  _chronological(slots) {
    return [...slots].sort((a, b) => this.timeToMinutes(a) - this.timeToMinutes(b));
  }

  // Slots whose lesson would overlap a lesson already booked in the database.
  // Calendar checks alone miss lessons that have no calendar event.
  _bookedSlots(slots, bookings, lessonMin, requestedMin = lessonMin) {
    const timed = bookings.filter((b) => typeof b.time === "string" && /^\d{1,2}:\d{2}$/.test(b.time));
    return slots.filter((slot) => {
      const start = this.timeToMinutes(slot);
      return timed.some((b) => {
        const other = this.timeToMinutes(b.time);
        return start < other + (b.durationMin || lessonMin) && other < start + requestedMin;
      });
    });
  }

  _applyLearnerTimeRules(slots, date, prefs) {
    const unavailable = prefs?.unavailable || [];
    if (!unavailable.length) return slots;
    const day = Number(timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "d"));
    return slots.filter((slot) => {
      const m = this.timeToMinutes(slot);
      return !unavailable.some(
        (u) =>
          (!u.days?.length || u.days.includes(day)) &&
          u.from && u.to &&
          m >= this.timeToMinutes(u.from) &&
          m < this.timeToMinutes(u.to)
      );
    });
  }

  _preferredSlots(slots, date, prefs) {
    const times = prefs?.preferredTimes || [];
    const days = prefs?.preferredDays || [];
    if (!times.length && !days.length) return [];
    const day = Number(timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "d"));
    if (days.length && !days.includes(day)) return [];
    return times.length ? slots.filter((s) => times.includes(s)) : [...slots];
  }

  async _weeklyLimitReached(date, instructorId, userPhone, prefs) {
    const cap = prefs?.maxLessonsPerWeek;
    if (!cap || !userPhone) return false;
    const day = Number(timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "d"));
    const monday = timezoneUtils.addDays(date, -((day + 6) % 7));
    const sunday = timezoneUtils.addDays(monday, 6);
    const count = await Booking.countDocuments({
      userPhone,
      instructorId,
      status: { $in: ACTIVE_STATUSES },
      date: { $gte: monday, $lte: sunday },
    });
    return count >= cap;
  }

  /**
   * Everything the bot needs to know about one date for one learner:
   * which slots to offer (chronological), the scored evaluations, the
   * learner's preferred slots, and a reason if the day is closed to them.
   */
  async planDay({
    date,
    instructor,
    availableSlots,
    userLoc = null,
    prefs = {},
    userPhone = null,
    durationMin = null,
    dropoffLoc = null,
    requestedTime = null,
    excludeBookingId = null,
  }) {
    const route = settings.resolveRouteSettings(instructor);
    const bot = settings.resolveBotSettings(instructor);
    const instructorId = instructor?.phoneNumberId;
    const lessonMin = durationMin || route.lessonDurationMin;
    const empty = { offered: [], evaluations: [], preferred: [] };

    if (route.packed) {
      return this._planPackedDay({ date, instructor, route, bot, userLoc, prefs, userPhone, lessonMin, dropoffLoc, requestedTime, excludeBookingId });
    }

    if (!availableSlots?.length) return empty;

    const bookings = (await Booking.find({
      date,
      instructorId,
      status: { $in: ACTIVE_STATUSES },
    })).filter((b) => !excludeBookingId || b.bookingId !== excludeBookingId);

    if (bot.maxLessonsPerDay && bookings.length >= bot.maxLessonsPerDay) {
      return { ...empty, blockedReason: "day_full" };
    }
    if (await this._weeklyLimitReached(date, instructorId, userPhone, prefs)) {
      return { ...empty, blockedReason: "weekly_limit" };
    }

    const booked = this._bookedSlots(availableSlots, bookings, route.lessonDurationMin, lessonMin);
    const slots = this._applyLearnerTimeRules(availableSlots, date, prefs).filter((s) => !booked.includes(s));
    const userPt = this._toPoint(userLoc);

    if (!route.enabled || !userPt || !slots.length) {
      const offered = this._chronological(slots);
      return { offered, evaluations: [], preferred: this._preferredSlots(offered, date, prefs), booked };
    }

    const homePt = this.homePoint(instructor);
    if (!homePt) {
      logger.warn(`Route optimiser: instructor ${instructorId} has no base location; home legs ignored`);
    }

    const departure = timezoneUtils.createDateInTimezone(date, this._chronological(slots)[0]);
    const evaluations = await this.scoreSlots(
      slots,
      bookings,
      { lat: userPt.lat, long: userPt.lng },
      homePt ? { lat: homePt.lat, long: homePt.lng } : null,
      route,
      departure,
      { durationMin: lessonMin, dropoffLoc }
    );

    return { ...this._chooseOffered(date, evaluations, route, prefs), booked };
  }

  // Which feasible slots to offer: those within the learner's added-drive
  // limit (priority learners have none), else the best few.
  _chooseOffered(date, evaluations, route, prefs) {
    const maxAdded = prefs?.priority
      ? Infinity
      : (prefs?.maxAddedDriveMin ?? route.maxAddedDriveMin);
    const feasible = evaluations.filter((e) => e.feasible);
    const within = feasible.filter((e) => e.addedDrive <= maxAdded);
    const chosen = within.length ? within : feasible.slice(0, FALLBACK_OFFER_COUNT);
    const offered = this._chronological(chosen.map((e) => e.slot));

    logger.info(
      `Route optimiser ${date}: offered [${offered.join(", ")}]` +
      `${within.length ? "" : feasible.length ? " (fallback: none within limit)" : " (none reachable)"}; top: ` +
      evaluations.slice(0, 5).map((e) => `${e.slot} ${e.feasible ? e.score.toFixed(1) : "✗"} (${e.reason})`).join(" | ")
    );

    return {
      offered,
      evaluations,
      preferred: this._preferredSlots(offered, date, prefs),
      usedFallback: !within.length && feasible.length > 0,
    };
  }

  /**
   * Calendar events that aren't lessons, as blocks in minutes for the packer.
   * Lessons are already in the day plan, so their events are skipped.
   */
  async _busyBlocks(date, instructor, bookings) {
    const calendarService = require("./calendarService");
    try {
      const skip = new Set(bookings.map((b) => b.calendarEventId).filter(Boolean));
      const blocks = await calendarService.getBusyBlocks(date, instructor, skip);
      return Array.isArray(blocks) ? blocks : [];
    } catch (err) {
      logger.warn(`Calendar blocks unavailable for ${date}: ${err.message}`);
      return [];
    }
  }

  /**
   * Packed mode: generates the starts instead of filtering a fixed list.
   * Gaps use real drive times (plus the variance) where both ends are known,
   * else X, so a learner near the previous lesson can start sooner.
   * One Routes matrix call covers both generating and scoring.
   */
  async _planPackedDay({ date, instructor, route, bot, userLoc, prefs, userPhone, lessonMin, dropoffLoc, requestedTime, excludeBookingId }) {
    const instructorId = instructor?.phoneNumberId;
    const empty = { offered: [], evaluations: [], preferred: [], free: [], booked: [] };
    const window = settings.dayWindow(instructor, date);
    if (!window) return empty;

    const allBookings = await Booking.find({ date, instructorId, status: { $in: ACTIVE_STATUSES } });
    // A lesson being moved doesn't get in its own way
    const bookings = allBookings.filter((b) => !excludeBookingId || b.bookingId !== excludeBookingId);
    if (bot.maxLessonsPerDay && bookings.length >= bot.maxLessonsPerDay) {
      return { ...empty, blockedReason: "day_full" };
    }
    if (await this._weeklyLimitReached(date, instructorId, userPhone, prefs)) {
      return { ...empty, blockedReason: "weekly_limit" };
    }

    const plan = this.buildDayPlan(bookings, route);
    const blocks = [...settings.breakBlocks(instructor), ...(await this._busyBlocks(date, instructor, allBookings))];
    const userPt = this._toPoint(userLoc);
    const userEndPt = this._toPoint(dropoffLoc) || userPt;
    const homePt = this.homePoint(instructor);

    let travel = null;
    if (userPt) {
      const departure = timezoneUtils.createDateInTimezone(date, settings.toTime(window.start));
      travel = await this.buildTravel(plan, userPt, homePt, departure, userEndPt);
    }

    const packArgs = {
      start: window.start,
      end: window.end,
      d: lessonMin,
      X: route.bufferMin,
      lunch: settings.lunchWindow(instructor),
      items: [...plan, ...blocks],
      gap: this._packedGap(route, travel, userPt, userEndPt, homePt),
      maxLessons: bot.maxLessonsPerDay || null,
    };
    const starts = dayPacker.candidateStarts(packArgs);
    if (requestedTime && /^\d{2}:\d{2}$/.test(requestedTime)) {
      const s = this.timeToMinutes(requestedTime);
      if (!starts.includes(s) && dayPacker.isStartFeasible({ ...packArgs, s })) starts.push(s);
    }

    const free = this._chronological(
      this._applyLearnerTimeRules(starts.map(settings.toTime), date, prefs)
    );
    // Whether this learner only fits where a long drive costs nothing (so Donna can say why)
    const items = [...packArgs.items].sort((a, b) => a.start - b.start);
    const longDrive = free.length > 0 && free.every((t) => {
      const st = this.timeToMinutes(t);
      const { prev, next } = dayPacker.neighbours(items, st, lessonMin);
      return (prev && packArgs.gap(prev, dayPacker.NEW) > packArgs.X) || (next && packArgs.gap(dayPacker.NEW, next) > packArgs.X);
    });

    if (!userPt || !free.length) {
      return { offered: free, evaluations: [], preferred: this._preferredSlots(free, date, prefs), free, booked: [], longDrive };
    }

    const slotOpts = { durationMin: lessonMin, userEndPt };
    const evaluations = free
      .map((slot) => this.scoreSlot(slot, plan, userPt, homePt, route, travel, free, slotOpts))
      .sort((a, b) => {
        if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
        return a.score - b.score;
      });

    return { ...this._chooseOffered(date, evaluations, route, prefs), free, booked: [], longDrive };
  }

  /**
   * Packed mode: whether a lesson can start at this exact time for this
   * learner (same rules as the offered starts). Used to validate bookings.
   */
  async isPackedStartAvailable({ date, time, instructor, durationMin, userLoc = null, dropoffLoc = null, excludeBookingId = null }) {
    const day = await this.planDay({
      date,
      instructor,
      availableSlots: null,
      userLoc,
      durationMin,
      dropoffLoc,
      requestedTime: time,
      excludeBookingId,
    });
    if (day.blockedReason || !day.free.includes(time)) return false;
    const evaluation = day.evaluations.find((e) => e.slot === time);
    return !evaluation || evaluation.feasible;
  }

  /**
   * The learner's location and scheduling preferences for this instructor.
   * Location priority: explicit override (pickup given in this conversation)
   * → first saved place → profile postcode location.
   */
  async resolveUserContext(instructor, userPhone, override = null) {
    const instructorId = instructor?.phoneNumberId;
    const user = await User.findOne({ phone: userPhone, ...(instructorId && { instructorId }) });
    const prefs = plainPrefs(user?.schedulingPrefs);

    let userLoc = null;
    if (override && typeof override.lat === "number" && typeof override.long === "number") {
      userLoc = { lat: override.lat, long: override.long };
    } else {
      const saved = (prefs.savedPlaces || []).find((p) => typeof p.latitude === "number");
      if (saved) userLoc = { lat: saved.latitude, long: saved.longitude };
      else if (user?.location?.latitude && user?.location?.longitude) {
        userLoc = { lat: user.location.latitude, long: user.location.longitude };
      }
    }

    return { user, prefs, userLoc };
  }

  /**
   * Back-compatible entry point: the slots to offer a learner on a date.
   * Returns the input unchanged if anything goes wrong.
   */
  async filterAvailableSlotsByLocation(availableSlotsForDate, dateRequested, instructor, userPhone, userLocationOverride = null) {
    try {
      if (!availableSlotsForDate || availableSlotsForDate.length === 0) {
        return availableSlotsForDate;
      }
      const { prefs, userLoc } = await this.resolveUserContext(instructor, userPhone, userLocationOverride);
      if (!userLoc) {
        logger.warn(`User location not found for ${userPhone}, returning all slots`);
      }
      const { offered } = await this.planDay({
        date: dateRequested,
        instructor,
        availableSlots: availableSlotsForDate,
        userLoc,
        prefs,
        userPhone,
      });
      return offered;
    } catch (error) {
      logger.error(`Route optimiser error: ${error.message}`);
      return availableSlotsForDate;
    }
  }

  /**
   * Evaluates one specific slot (used when recording a booking's added drive).
   */
  async evaluateSlot(date, time, instructor, userLoc, { durationMin = null, dropoffLoc = null } = {}) {
    const route = settings.resolveRouteSettings(instructor);
    const userPt = this._toPoint(userLoc);
    if (!userPt) return null;
    const userEndPt = this._toPoint(dropoffLoc) || userPt;
    const bookings = await Booking.find({
      date,
      instructorId: instructor?.phoneNumberId,
      status: { $in: ACTIVE_STATUSES },
    });
    const homePt = this.homePoint(instructor);
    const plan = this.buildDayPlan(bookings, route);
    const travel = await this.buildTravel(plan, userPt, homePt, timezoneUtils.createDateInTimezone(date, time), userEndPt);
    const result = this.scoreSlot(time, plan, userPt, homePt, route, travel, [time], { durationMin, userEndPt });
    // The drive in from the lesson before, and the gap left for it (shown on the dashboard)
    const s = this.timeToMinutes(time);
    const prev = [...plan].reverse().find((p) => p.endAt <= s);
    if (prev && prev.endLoc) {
      result.driveIn = travel(prev.endLoc, userPt);
      result.gapBefore = s - prev.endAt;
    }
    return result;
  }

  /**
   * The best-fitting slot on each of the next few bookable days, ordered by
   * least added driving. Used to suggest "I'm already near you on Tuesday".
   */
  async suggestBestDays(instructor, { userLoc, prefs = {}, userPhone = null, excludeDate = null, limit = 3, durationMin = null, dropoffLoc = null } = {}) {
    const route = settings.resolveRouteSettings(instructor);
    if (!route.enabled || !route.suggestOtherDays || !this._toPoint(userLoc)) return [];

    const calendarService = require("./calendarService");
    const dates = settings
      .upcomingBookableDates(instructor, route.lookAheadDays + 1)
      .filter((d) => d !== excludeDate)
      .slice(0, route.lookAheadDays);

    const results = await Promise.all(
      dates.map(async (date) => {
        try {
          const free = await calendarService.getAvailableTimeSlotsForDate(date, instructor, durationMin);
          const day = await this.planDay({ date, instructor, availableSlots: free, userLoc, prefs, userPhone, durationMin, dropoffLoc });
          const best = day.evaluations.find((e) => e.feasible && day.offered.includes(e.slot));
          return best
            ? { date, time: best.slot, addedDrive: best.addedDrive, reason: best.reason, count: day.offered.length }
            : null;
        } catch (err) {
          logger.warn(`Best-days check failed for ${date}: ${err.message}`);
          return null;
        }
      })
    );

    return results
      .filter(Boolean)
      .sort((a, b) => a.addedDrive - b.addedDrive || a.date.localeCompare(b.date))
      .slice(0, limit);
  }

  /**
   * The earliest date with a slot this learner can be offered, and the
   * best-fitting slot on that date.
   */
  async findEarliestOfferedSlot(instructor, userPhone, { durationMin = null } = {}) {
    const calendarService = require("./calendarService");
    const route = settings.resolveRouteSettings(instructor);
    const { prefs, userLoc } = await this.resolveUserContext(instructor, userPhone);
    const dates = settings.upcomingBookableDates(instructor, Math.max(route.lookAheadDays, 30));

    for (const date of dates) {
      const free = await calendarService.getAvailableTimeSlotsForDate(date, instructor, durationMin);
      const day = await this.planDay({ date, instructor, availableSlots: free, userLoc, prefs, userPhone, durationMin });
      if (!day.offered.length) continue;
      const best = day.evaluations.find((e) => e.feasible && day.offered.includes(e.slot));
      return { date, time: best ? best.slot : day.offered[0] };
    }
    return null;
  }

  /**
   * Whether a learner is inside the instructor's service area. With no
   * area configured everyone is inside.
   */
  checkServiceArea(instructor, userLoc, postcode = null) {
    const { serviceArea } = settings.resolveRouteSettings(instructor);
    const hasRadius = !!serviceArea.radiusMiles;
    const hasDistricts = serviceArea.postcodeDistricts.length > 0;
    if (!hasRadius && !hasDistricts) return { inside: true };

    if (hasDistricts && postcode) {
      const match = postcode.trim().match(UK_POSTCODE);
      const district = (match ? match[1] : postcode.trim().split(/\s+/)[0]).toUpperCase();
      if (serviceArea.postcodeDistricts.includes(district)) return { inside: true };
    }

    const home = this.homePoint(instructor);
    const user = this._toPoint(userLoc);
    if (hasRadius && home && user) {
      const miles = haversine(home.lat, home.lng, user.lat, user.lng) / KM_PER_MILE;
      if (miles <= serviceArea.radiusMiles) return { inside: true };
      // Tell the learner in the unit the instructor set their area in
      const away = serviceArea.unit === "km" ? miles * KM_PER_MILE : miles;
      return { inside: false, reason: `about ${Math.round(away)} ${serviceArea.unit} away (area is ${serviceArea.radius} ${serviceArea.unit})` };
    }

    if (hasDistricts && postcode) return { inside: false, reason: "postcode is outside the instructor's area" };
    return { inside: true };
  }
}

function plainPrefs(prefs) {
  if (!prefs) return {};
  return typeof prefs.toObject === "function" ? prefs.toObject() : prefs;
}

module.exports = new RouteOptimizer();
