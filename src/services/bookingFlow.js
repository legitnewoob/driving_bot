// Step-by-step booking and moving over WhatsApp lists, so learners tap
// instead of typing: menu → lesson type (sets the length) → pickup →
// drop-off → date → time → confirm. Typing works at every step too.
//
// State lives in the learner's pending context (aiService.pendingContext[phone].flow),
// which sessionStore already saves between messages and restarts.

const aiService = require("./gemini/aiService");
const dateTimeService = require("./gemini/dateTimeService");
const dateTimeUtils = require("../utils/dateTimeUtils");
const routeOptimizer = require("./routeOptimizer");
const settings = require("./instructorSettings");
const bookingService = require("./bookingService");
const calendarService = require("./calendarService");
const { getCoordinatesFromPostalCode } = require("./mapsService");
const { formatDuration } = require("./lessonTypes");
const LessonType = require("../models/lessonTypeModel");
const Booking = require("../models/bookingModel");
const timezoneUtils = require("../utils/timezoneUtils");
const { to12h } = require("../utils/timeFormat");
const logger = require("../utils/logger-advanced");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ROWS = 10;
const MAX_DATE_ROWS = 9; // plus "Another date"
const MAX_TIME_ROWS = 9; // plus "Another day"
const DATE_SEARCH_DAYS = 21;
const ACTIVE = ["confirmed", "rescheduled"];

const GREETING = /^\s*(hi+|hello|hey+|hiya|heya|yo|morning|afternoon|evening|good (morning|afternoon|evening)|menu|start|help|hola)\b[\s!.,👋🙂😊]*$/i;
const RESET = /^\s*(menu|start again|restart|start over|main menu)\s*[.!]*$/i;
const STOP = /^\s*(stop|cancel that|never ?mind|forget it|quit|exit)\s*[.!]*$/i;
const YES = /^\s*(yes|yeah|yep|yup|ok|okay|sure|book it|confirm|go ahead|please do|👍)\b/i;
const NO = /^\s*(no|nope|nah|change)\b/i;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

function formatDay(date) {
  return timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "ddd D MMM");
}

function addMinutes(time, minutes) {
  return settings.toTime(settings.toMinutes(time) + minutes);
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

const place = (address, lat, long) => ({ address, lat, long });

// A place stored on a booking or user, as a flow place (or null)
function placeFrom(loc) {
  if (!loc?.address) return null;
  return place(loc.address, loc.latitude ?? null, loc.longitude ?? null);
}

class BookingFlow {
  /* ========== STATE ========== */

  get(phone) {
    return aiService.pendingContext[phone]?.flow || null;
  }

  _set(phone, flow) {
    if (!aiService.pendingContext[phone]) aiService.pendingContext[phone] = {};
    aiService.pendingContext[phone].flow = flow;
    aiService.pendingContext[phone]._updatedAt = Date.now();
    // Keep the AI's view in step: the length and places drive its availability checks
    if (flow?.lessonTypeId) {
      aiService.setPendingLessonType(phone, {
        _id: flow.lessonTypeId,
        name: flow.lessonTypeName,
        durationMin: flow.durationMin,
      });
    }
    if (flow?.pickup) {
      Object.assign(aiService.pendingContext[phone], {
        pickupAddress: flow.pickup.address,
        pickupCoords: flow.pickup.lat != null ? { lat: flow.pickup.lat, long: flow.pickup.long } : null,
      });
    }
    if (flow?.dropoff) {
      Object.assign(aiService.pendingContext[phone], {
        dropoffAddress: flow.dropoff.address,
        dropoffCoords: flow.dropoff.lat != null ? { lat: flow.dropoff.lat, long: flow.dropoff.long } : null,
      });
    }
  }

  clear(phone) {
    if (aiService.pendingContext[phone]) delete aiService.pendingContext[phone].flow;
  }

  isGreeting(text) {
    return GREETING.test(text || "");
  }

  /* ========== MENU ========== */

  async _upcoming(ctx) {
    const today = timezoneUtils.getCurrentDateString();
    try {
      const list = await Booking.find({
        userPhone: ctx.from,
        instructorId: ctx.instructorId,
        status: { $in: ACTIVE },
        date: { $gte: today },
      }).lean();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async showMenu(ctx, user, { greet = true } = {}) {
    this.clear(ctx.from);
    const upcoming = await this._upcoming(ctx);
    const teacher = firstName(ctx.instructor.name) || "your instructor";
    const rows = [{ id: "bf:menu:book", title: "Book a lesson" }];
    if (upcoming.length) {
      if (ctx.bot.allowReschedule) rows.push({ id: "bf:menu:move", title: "Move a lesson" });
      if (ctx.bot.allowCancel) rows.push({ id: "bf:menu:cancel", title: "Cancel a lesson" });
      rows.push({ id: "bf:menu:mine", title: "My lessons", description: `${upcoming.length} coming up` });
    }
    if (ctx.bot.handover) rows.push({ id: "bf:menu:talk", title: `Talk to ${teacher}` });

    const name = firstName(user?.name);
    const intro = greet
      ? `Hi${name ? ` ${name}` : ""}! 👋 I'm Donna, ${ctx.instructor.name}'s booking assistant. What would you like to do?`
      : "What would you like to do?";
    await ctx.sendList(intro, "Choose an option", rows);
  }

  /* ========== START ========== */

  /**
   * Starts booking. `prefill` holds anything already known (from the AI or a
   * tap): lessonType (name), lessonTypeId, date, time, pickupAddress, dropoffAddress.
   */
  async startBooking(ctx, user, prefill = {}, controller = null) {
    // Already booking: keep what's been chosen and add the new details
    const existing = this.get(ctx.from);
    const flow = existing?.kind === "book" ? existing : { kind: "book", step: null };
    await this._applyPrefill(ctx, flow, prefill);
    this._set(ctx.from, flow);
    return this.next(ctx, user, controller);
  }

  /** Starts moving a lesson: asks what to change. */
  async startMove(ctx, booking) {
    const flow = {
      kind: "move",
      step: "move_what",
      bookingId: booking.bookingId,
      orig: { date: booking.date, time: booking.time },
      lessonTypeId: booking.lessonTypeId ? String(booking.lessonTypeId) : null,
      lessonTypeName: booking.lessonTypeName || "",
      durationMin: booking.durationMin || null,
      price: booking.price ?? null,
      pickup: placeFrom(booking.pickupLocation),
      dropoff: placeFrom(booking.dropoffLocation),
      date: booking.date,
      time: booking.time,
      eventId: booking.calendarEventId || null,
    };
    this._set(ctx.from, flow);
    return this._askMoveWhat(ctx, flow);
  }

  async _askMoveWhat(ctx, flow) {
    flow.step = "move_what";
    this._set(ctx.from, flow);
    const types = await this._types(ctx);
    const rows = [
      { id: "bf:mv:when", title: "Date & time" },
      { id: "bf:mv:place", title: "Pickup / drop-off" },
      ...(types.length > 1 ? [{ id: "bf:mv:type", title: "Lesson type", description: "Changes how long it is" }] : []),
    ];
    await ctx.sendList(
      `Moving your lesson on ${formatDay(flow.orig.date)} at ${to12h(flow.orig.time)} (${flow.bookingId}). What would you like to change?`,
      "Choose",
      rows
    );
  }

  async _applyPrefill(ctx, flow, given) {
    // What the chat already settled (a tapped lesson type, a pickup Donna was told)
    const pending = aiService.pendingContext[ctx.from] || {};
    const prefill = {
      lessonTypeId: flow.lessonTypeId ? null : pending.lessonTypeId,
      pickupAddress: flow.pickup ? null : pending.pickupAddress,
      pickupCoords: flow.pickup ? null : pending.pickupCoords,
      dropoffAddress: flow.dropoff ? null : pending.dropoffAddress,
      ...Object.fromEntries(Object.entries(given || {}).filter(([, v]) => v != null && v !== "")),
    };
    if (given?.pickupAddress && !given?.pickupCoords) prefill.pickupCoords = null;
    const types = await this._types(ctx);
    let type = null;
    if (prefill.lessonTypeId) type = types.find((t) => String(t._id) === String(prefill.lessonTypeId));
    if (!type && prefill.lessonType) type = this._matchType(types, prefill.lessonType);
    if (type) this._chooseType(flow, type);

    if (prefill.pickupAddress) {
      const p = prefill.pickupCoords
        ? place(prefill.pickupAddress, prefill.pickupCoords.lat, prefill.pickupCoords.long)
        : await this._geocode(prefill.pickupAddress);
      if (p) flow.pickup = p;
    }
    if (prefill.dropoffAddress) {
      const d = await this._geocode(prefill.dropoffAddress);
      if (d) flow.dropoff = d;
    }
    const today = timezoneUtils.getCurrentDateString();
    if (DATE.test(prefill.date || "") && prefill.date > today) flow.date = prefill.date;
    if (flow.date && TIME.test(prefill.time || "")) flow.time = prefill.time;
  }

  /* ========== STEPS ========== */

  async _types(ctx) {
    try {
      const types = await LessonType.find({ instructorId: ctx.instructorId, active: true })
        .sort({ sortOrder: 1, createdAt: 1 })
        .lean();
      return Array.isArray(types) ? types : [];
    } catch {
      return [];
    }
  }

  _chooseType(flow, type) {
    flow.lessonTypeId = String(type._id);
    flow.lessonTypeName = type.name;
    flow.durationMin = type.durationMin || null;
    flow.price = type.price ?? null;
  }

  _matchType(types, text) {
    const wanted = String(text || "").trim().toLowerCase();
    if (!wanted) return null;
    const byName =
      types.find((t) => t.name.toLowerCase() === wanted) ||
      types.find((t) => wanted.includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(wanted));
    if (byName) return byName;
    // "2 hours", "90 min", "1.5h", "an hour and a half"
    let minutes = null;
    const hours = wanted.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/);
    const mins = wanted.match(/(\d+)\s*(m|min|mins|minutes)\b/);
    if (/hour and a half|1 and a half/.test(wanted)) minutes = 90;
    else if (/^an? hour\b|\bone hour\b/.test(wanted)) minutes = 60;
    else if (/\btwo hours?\b/.test(wanted)) minutes = 120;
    else if (hours) minutes = Math.round(parseFloat(hours[1]) * 60) + (mins ? Number(mins[1]) : 0);
    else if (mins) minutes = Number(mins[1]);
    return minutes ? types.find((t) => t.durationMin === minutes) || null : null;
  }

  /** Asks the next missing thing, or shows the summary. */
  async next(ctx, user, controller = null) {
    const flow = this.get(ctx.from);
    if (!flow) return this.showMenu(ctx, user);

    if (!flow.lessonTypeId) {
      const types = await this._types(ctx);
      if (types.length === 1) this._chooseType(flow, types[0]);
      else if (types.length > 1) return this._askType(ctx, flow, types);
    }
    if (!flow.pickup) return this._askPlace(ctx, user, flow, "pickup");
    if (!flow.dropoff) return this._askPlace(ctx, user, flow, "dropoff");
    if (!flow.date) return this._askDate(ctx, user, flow);
    if (!flow.time) return this._askTime(ctx, user, flow, flow.date);
    if (flow.recheck || flow.kind === "book") {
      // A time picked earlier (or the lesson's current time) may not fit any more
      const problem = await this._timeProblem(ctx, user, flow);
      if (problem) {
        await ctx.send(problem);
        flow.time = null;
        flow.recheck = false;
        this._set(ctx.from, flow);
        return this._askTime(ctx, user, flow, flow.date);
      }
      flow.recheck = false;
    }
    return this._askConfirm(ctx, flow);
  }

  async _askType(ctx, flow, types) {
    flow.step = "type";
    this._set(ctx.from, flow);
    const last = await this._lastBooking(ctx);
    const lastId = last?.lessonTypeId ? String(last.lessonTypeId) : null;
    const ordered = [...types].sort((a, b) => (String(b._id) === lastId) - (String(a._id) === lastId));
    const rows = ordered.slice(0, MAX_ROWS).map((t) => ({
      id: `bf:type:${t._id}`,
      title: t.name,
      description: [
        t.durationMin ? formatDuration(t.durationMin) : null,
        `£${t.price}`,
        String(t._id) === lastId ? "Same as last time" : t.description || null,
      ].filter(Boolean).join(" · "),
    }));
    await ctx.sendList("Which lesson would you like?", "Choose a lesson", rows);
  }

  async _lastBooking(ctx) {
    try {
      const list = await Booking.find({ userPhone: ctx.from, instructorId: ctx.instructorId })
        .sort({ date: -1, time: -1 })
        .limit(1)
        .lean();
      return Array.isArray(list) ? list[0] || null : null;
    } catch {
      return null;
    }
  }

  // The places this learner is likely to want, best first, without repeats
  async _knownPlaces(ctx, user, kind) {
    const out = [];
    const seen = new Set();
    const add = (id, title, p) => {
      if (!p?.address) return;
      const key = p.address.trim().toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id, title, place: p });
    };
    const last = await this._lastBooking(ctx);
    add(`bf:${kind}:last`, "Same as last time", placeFrom(kind === "pickup" ? last?.pickupLocation : last?.dropoffLocation));
    (user?.schedulingPrefs?.savedPlaces || []).forEach((sp, i) =>
      add(`bf:${kind}:saved:${i}`, sp.label, place(sp.address, sp.latitude ?? null, sp.longitude ?? null))
    );
    if (user?.postalCode) {
      add(`bf:${kind}:home`, "My postcode", place(user.postalCode, user.location?.latitude ?? null, user.location?.longitude ?? null));
    }
    return out;
  }

  async _askPlace(ctx, user, flow, kind) {
    flow.step = kind;
    flow.awaiting = null;
    this._set(ctx.from, flow);
    const known = await this._knownPlaces(ctx, user, kind);
    const rows = [];
    if (kind === "dropoff" && flow.pickup) {
      rows.push({ id: "bf:dropoff:same", title: "Same as pickup", description: flow.pickup.address });
    }
    for (const k of known) rows.push({ id: k.id, title: k.title, description: k.place.address });
    rows.splice(MAX_ROWS - 2);
    rows.push({ id: `bf:${kind}:pin`, title: "📍 Send my location" });
    rows.push({ id: `bf:${kind}:type`, title: "Type an address" });
    await ctx.sendList(
      kind === "pickup" ? "Where should I pick you up?" : "And where should the lesson finish?",
      kind === "pickup" ? "Choose pickup" : "Choose drop-off",
      rows
    );
  }

  _lessonDuration(ctx, flow) {
    return flow.durationMin || settings.resolveRouteSettings(ctx.instructor).lessonDurationMin;
  }

  // The day as this learner would see it: what can be offered, with the length and places
  async _planFor(ctx, user, flow, date, requestedTime = null) {
    const durationMin = this._lessonDuration(ctx, flow);
    const userLoc = flow.pickup?.lat != null ? { lat: flow.pickup.lat, long: flow.pickup.long } : null;
    const dropoffLoc = flow.dropoff?.lat != null ? { lat: flow.dropoff.lat, long: flow.dropoff.long } : null;
    const prefs = user?.schedulingPrefs?.toObject ? user.schedulingPrefs.toObject() : user?.schedulingPrefs || {};
    const free = await calendarService.getAvailableTimeSlotsForDate(date, ctx.instructor, durationMin);
    return routeOptimizer.planDay({
      date,
      instructor: ctx.instructor,
      availableSlots: free,
      userLoc,
      dropoffLoc,
      prefs,
      userPhone: ctx.from,
      durationMin,
      requestedTime,
      excludeBookingId: flow.kind === "move" ? flow.bookingId : null,
    });
  }

  _offeredTimes(day, flow) {
    // A lesson being moved keeps its own time as an option
    const times = [...(day.offered || [])];
    if (flow.kind === "move" && flow.orig && flow.date === flow.orig.date) {
      return times.filter((t) => t !== flow.orig.time);
    }
    return times;
  }

  async _askDate(ctx, user, flow) {
    flow.step = "date";
    flow.awaiting = null;
    this._set(ctx.from, flow);

    const dates = settings.upcomingBookableDates(ctx.instructor, DATE_SEARCH_DAYS);
    const days = await Promise.all(
      dates.map(async (date) => {
        try {
          const day = await this._planFor(ctx, user, flow, date);
          const times = this._offeredTimes(day, flow);
          if (!times.length) return null;
          const best = (day.evaluations || []).find((e) => e.feasible && times.includes(e.slot));
          return { date, count: times.length, addedDrive: best?.addedDrive ?? null };
        } catch (err) {
          logger.warn(`Date list: ${date} skipped: ${err.message}`);
          return null;
        }
      })
    );
    const open = days.filter(Boolean).slice(0, MAX_DATE_ROWS);

    if (!open.length) {
      flow.step = "none";
      this._set(ctx.from, flow);
      const buttons = [{ id: "bf:wl", title: "Join waiting list" }];
      if (ctx.bot.handover) buttons.push({ id: "bf:menu:talk", title: `Talk to ${firstName(ctx.instructor.name) || "instructor"}` });
      return ctx.sendButtons(
        `Sorry, there's nothing free for a ${formatDuration(this._lessonDuration(ctx, flow))} lesson in the next few weeks. ` +
          `I can let you know as soon as something opens up.`,
        buttons
      );
    }

    const scored = open.filter((d) => d.addedDrive != null);
    const bestDate = scored.length > 1 ? scored.reduce((a, b) => (b.addedDrive < a.addedDrive ? b : a)).date : null;
    const rows = open.map((d) => ({
      id: `bf:date:${d.date}`,
      title: formatDay(d.date),
      description: `${d.count} time${d.count === 1 ? "" : "s"} free${d.date === bestDate ? " · ⭐ Best fit" : ""}`,
    }));
    rows.push({ id: "bf:date:other", title: "Another date", description: "Type the day you'd like" });
    await ctx.sendList("Which day suits you?", "Choose a day", rows);
  }

  async _askTime(ctx, user, flow, date) {
    flow.step = "time";
    flow.date = date;
    flow.awaiting = null;
    this._set(ctx.from, flow);

    const day = await this._planFor(ctx, user, flow, date);
    const times = this._offeredTimes(day, flow).slice(0, MAX_TIME_ROWS);
    const length = this._lessonDuration(ctx, flow);

    if (!times.length) {
      const why = day.blockedReason === "weekly_limit"
        ? "You've reached your lesson limit for that week."
        : `There's nothing free on ${formatDay(date)} for a ${formatDuration(length)} lesson.`;
      await ctx.send(`${why} Here are the days that work:`);
      flow.date = null;
      this._set(ctx.from, flow);
      return this._askDate(ctx, user, flow);
    }

    const rows = times.map((t) => ({ id: `bf:time:${t}`, title: `${to12h(t)} – ${to12h(addMinutes(t, length))}` }));
    rows.push({ id: "bf:date:pick", title: "Another day" });
    await ctx.sendList(`Here's what's free on ${formatDay(date)}:`, "Choose a time", rows);
  }

  // Why the chosen time can't be booked as it stands, or null if it's fine
  async _timeProblem(ctx, user, flow) {
    try {
      const day = await this._planFor(ctx, user, flow, flow.date, flow.time);
      if (day.blockedReason === "day_full") return `Sorry, ${formatDay(flow.date)} is now fully booked.`;
      if (day.blockedReason === "weekly_limit") return "You've reached your lesson limit for that week.";
      const errors = await bookingService.validateBooking({ date: flow.date, time: flow.time }, ctx.instructor, {
        durationMin: this._lessonDuration(ctx, flow),
        userLoc: flow.pickup?.lat != null ? { lat: flow.pickup.lat, long: flow.pickup.long } : null,
        dropoffLoc: flow.dropoff?.lat != null ? { lat: flow.dropoff.lat, long: flow.dropoff.long } : null,
        excludeBookingId: flow.kind === "move" ? flow.bookingId : null,
        ignoreEventId: flow.kind === "move" ? flow.eventId : null,
      });
      const reachable = (day.evaluations || []).every((e) => e.slot !== flow.time || e.feasible);
      const clash = (day.booked || []).includes(flow.time);
      if (!errors.length && reachable && !clash) return null;
      return `${to12h(flow.time)} on ${formatDay(flow.date)} doesn't work for this lesson.`;
    } catch (err) {
      logger.warn(`Time check failed: ${err.message}`);
      return null; // booking validates again
    }
  }

  async _askConfirm(ctx, flow) {
    flow.step = "confirm";
    flow.awaiting = null;
    this._set(ctx.from, flow);
    const length = this._lessonDuration(ctx, flow);
    const lines = [
      flow.kind === "move" ? "Here's your lesson after the change:" : "Here's your lesson:",
      "",
      flow.lessonTypeName
        ? `🎯 ${flow.lessonTypeName} · ${formatDuration(length)}${flow.price != null ? ` · £${flow.price}` : ""}`
        : `🎯 ${formatDuration(length)} lesson`,
      `📅 ${formatDay(flow.date)}, ${to12h(flow.time)} – ${to12h(addMinutes(flow.time, length))}`,
      flow.pickup ? `📍 Pickup: ${flow.pickup.address}` : null,
      flow.dropoff ? `🏁 Drop-off: ${flow.dropoff.address}` : null,
    ].filter((l) => l !== null);
    await ctx.sendButtons(lines.join("\n"), [
      { id: "bf:ok", title: flow.kind === "move" ? "Move it" : "Book it" },
      { id: "bf:change", title: "Change something" },
      { id: "bf:stop", title: "Cancel" },
    ]);
  }

  async _askChange(ctx, flow) {
    flow.step = "change";
    this._set(ctx.from, flow);
    const types = await this._types(ctx);
    const rows = [
      ...(types.length > 1 ? [{ id: "bf:chg:type", title: "Lesson type" }] : []),
      { id: "bf:chg:pickup", title: "Pickup" },
      { id: "bf:chg:dropoff", title: "Drop-off" },
      { id: "bf:chg:date", title: "Day" },
      { id: "bf:chg:time", title: "Time" },
    ];
    await ctx.sendList("What would you like to change?", "Choose", rows);
  }

  /* ========== FINISH ========== */

  async _finish(ctx, user, controller) {
    const flow = this.get(ctx.from);
    if (!flow) return this.showMenu(ctx, user);
    const coords = (p) => (p?.lat != null ? { lat: p.lat, long: p.long } : undefined);

    if (flow.kind === "move") {
      const moved = await controller.updateBooking(ctx, {
        bookingId: flow.bookingId,
        newDate: flow.date,
        newTime: flow.time,
        ...(flow.lessonTypeId && { lessonTypeId: flow.lessonTypeId }),
        ...(flow.pickup && { pickupAddress: flow.pickup.address, pickupCoords: coords(flow.pickup) }),
        ...(flow.dropoff && { dropoffAddress: flow.dropoff.address, dropoffCoords: coords(flow.dropoff) }),
      });
      if (!moved) return this._recoverAfterFailure(ctx, user, flow);
      return;
    }

    const booked = await controller.processBooking(ctx, {
      userPhone: ctx.from,
      date: flow.date,
      time: flow.time,
      lessonTypeId: flow.lessonTypeId,
      lessonType: flow.lessonTypeName,
      pickupAddress: flow.pickup?.address,
      pickupCoords: coords(flow.pickup),
      dropoffAddress: flow.dropoff?.address,
      dropoffCoords: coords(flow.dropoff),
    });
    if (!booked) return this._recoverAfterFailure(ctx, user, flow);
  }

  // The time went (someone else booked it, or it no longer fits): fresh times
  async _recoverAfterFailure(ctx, user, flow) {
    flow.time = null;
    this._set(ctx.from, flow);
    return this._askTime(ctx, user, flow, flow.date);
  }

  /* ========== TAPS ========== */

  /** Handles a tapped bf:… row or button. */
  async handleTap(ctx, user, buttonId, controller) {
    const [, kind, ...rest] = buttonId.split(":");
    const value = rest.join(":");

    if (kind === "menu") {
      if (value === "book") return this.startBooking(ctx, user, {}, controller);
      if (value === "move" || value === "cancel") {
        if (!(await controller._allowed(ctx, value))) return;
        return controller.pickBooking(ctx, value);
      }
      if (value === "mine") return controller.showBookings(ctx);
      if (value === "talk") return controller.handover(ctx, user);
      return this.showMenu(ctx, user);
    }

    if (kind === "wl") {
      const flow = this.get(ctx.from);
      this.clear(ctx.from);
      return controller.joinWaitlist(ctx, flow?.date ? { fromDate: flow.date } : {});
    }

    const flow = this.get(ctx.from);
    if (!flow) {
      await ctx.send("That list has expired. Let's start again.");
      return this.showMenu(ctx, user, { greet: false });
    }

    switch (kind) {
      case "type": {
        const type = (await this._types(ctx)).find((t) => String(t._id) === value);
        if (!type) {
          await ctx.send("That lesson isn't available any more.");
          return this._askType(ctx, flow, await this._types(ctx));
        }
        this._chooseType(flow, type);
        if (flow.kind === "move") flow.recheck = true;
        else flow.time = null;
        this._set(ctx.from, flow);
        return this.next(ctx, user, controller);
      }
      case "pickup":
      case "dropoff": {
        if (value === "pin") {
          flow.awaiting = kind;
          this._set(ctx.from, flow);
          return ctx.send(`Tap 📎 (or +) → Location, and send the ${kind === "pickup" ? "pickup" : "drop-off"} spot.`);
        }
        if (value === "type") {
          flow.awaiting = kind;
          this._set(ctx.from, flow);
          return ctx.send(kind === "pickup" ? "What's the pickup address or postcode?" : "What's the drop-off address or postcode?");
        }
        let chosen = null;
        if (value === "same") chosen = flow.pickup;
        else {
          const known = await this._knownPlaces(ctx, user, kind);
          chosen = known.find((k) => k.id === buttonId)?.place || null;
        }
        if (!chosen) return this._askPlace(ctx, user, flow, kind);
        return this._setPlace(ctx, user, flow, kind, chosen, controller);
      }
      case "date": {
        if (value === "other") {
          flow.awaiting = "date";
          this._set(ctx.from, flow);
          return ctx.send("Which day would you like? You can say things like \"next Friday\" or \"3 June\".");
        }
        if (value === "pick") return this._askDate(ctx, user, flow);
        if (DATE.test(value)) {
          flow.time = null;
          return this._askTime(ctx, user, flow, value);
        }
        return this._askDate(ctx, user, flow);
      }
      case "time": {
        if (!TIME.test(value)) return this._askTime(ctx, user, flow, flow.date);
        flow.time = value;
        flow.recheck = false;
        this._set(ctx.from, flow);
        return this._askConfirm(ctx, flow);
      }
      case "mv": {
        if (value === "when") {
          flow.date = null;
          flow.time = null;
        } else if (value === "place") {
          flow.pickup = null;
          flow.dropoff = null;
          flow.recheck = true;
        } else if (value === "type") {
          flow.lessonTypeId = null;
          flow.recheck = true;
        }
        this._set(ctx.from, flow);
        return this.next(ctx, user, controller);
      }
      case "ok":
        return this._finish(ctx, user, controller);
      case "change":
        return this._askChange(ctx, flow);
      case "chg": {
        if (value === "type") {
          flow.lessonTypeId = null;
          flow.recheck = true;
        }
        if (value === "pickup") {
          flow.pickup = null;
          flow.recheck = true;
        }
        if (value === "dropoff") {
          flow.dropoff = null;
          flow.recheck = true;
        }
        if (value === "date") {
          flow.date = null;
          flow.time = null;
        }
        if (value === "time") flow.time = null;
        this._set(ctx.from, flow);
        return this.next(ctx, user, controller);
      }
      case "stop":
        this.clear(ctx.from);
        return ctx.send(flow.kind === "move" ? "No problem, your lesson stays as it was. 👍" : "No problem, nothing's been booked. 👍");
      default:
        return this.next(ctx, user, controller);
    }
  }

  async _setPlace(ctx, user, flow, kind, chosen, controller) {
    flow[kind] = chosen;
    flow.awaiting = null;
    if (flow.kind === "move") flow.recheck = true;
    // A new place changes which times fit
    else if (flow.time) flow.recheck = true;
    this._set(ctx.from, flow);
    return this.next(ctx, user, controller);
  }

  /* ========== TYPED ANSWERS ========== */

  async _geocode(text) {
    try {
      const geo = await getCoordinatesFromPostalCode(text.trim());
      return place(geo.formattedAddress || text.trim(), geo.lat, geo.lng);
    } catch (err) {
      logger.info(`Flow geocode failed for "${text}": ${err.message}`);
      return null;
    }
  }

  _looksLikeAddress(text) {
    const t = text.trim();
    if (POSTCODE.test(t)) return true;
    // "12 High Street", "Flat 3, 5 Mill Lane"
    return /\d/.test(t) && /[a-z]{3,}/i.test(t) && t.split(/\s+/).length >= 2 && !/\?$/.test(t);
  }

  // The date and time the learner typed, if they actually said them
  async _readDate(text) {
    try {
      const raw = dateTimeUtils.sanitize(await dateTimeService.extractDateTimeFromMessage(text), {});
      return {
        date: raw?.explicitDate === false ? null : raw?.date || null,
        time: raw?.explicitTime === false ? null : raw?.time || null,
      };
    } catch {
      return {};
    }
  }

  /**
   * A typed message while a flow is running. Returns true if it was taken as
   * the answer to the current step; false to let Donna's AI answer it (the
   * caller then shows the current step again with reprompt()).
   */
  async handleText(ctx, user, text, extra, controller) {
    const flow = this.get(ctx.from);
    if (!flow) return false;
    const trimmed = (text || "").trim();

    if (RESET.test(trimmed)) {
      await this.showMenu(ctx, user, { greet: false });
      return true;
    }
    if (STOP.test(trimmed)) {
      this.clear(ctx.from);
      await ctx.send(flow.kind === "move" ? "No problem, your lesson stays as it was. 👍" : "No problem, nothing's been booked. 👍");
      return true;
    }

    const step = flow.awaiting || flow.step;

    if (step === "pickup" || step === "dropoff") {
      if (extra?.location) {
        const p = place(extra.location.label, extra.location.lat, extra.location.long);
        await this._setPlace(ctx, user, flow, step, p, controller);
        return true;
      }
      if (flow.awaiting === step || this._looksLikeAddress(trimmed)) {
        if (step === "dropoff" && /\bsame\b/i.test(trimmed) && flow.pickup) {
          await this._setPlace(ctx, user, flow, step, flow.pickup, controller);
          return true;
        }
        const p = await this._geocode(trimmed);
        if (!p) {
          flow.awaiting = step;
          this._set(ctx.from, flow);
          await ctx.send("I couldn't find that address. Could you send the postcode, or share your location? 📍");
          return true;
        }
        await this._setPlace(ctx, user, flow, step, p, controller);
        return true;
      }
      return false;
    }

    // A shared pin outside the place steps is still most likely the pickup
    if (extra?.location && !flow.pickup) {
      const p = place(extra.location.label, extra.location.lat, extra.location.long);
      await this._setPlace(ctx, user, flow, "pickup", p, controller);
      return true;
    }

    if (step === "type") {
      const type = this._matchType(await this._types(ctx), trimmed);
      if (!type) return false;
      this._chooseType(flow, type);
      this._set(ctx.from, flow);
      await this.next(ctx, user, controller);
      return true;
    }

    if (step === "date" || step === "time") {
      const read = await this._readDate(trimmed);
      const today = timezoneUtils.getCurrentDateString();
      if (read.date && read.date > today) {
        if (!settings.isWorkingDay(ctx.instructor, read.date) || settings.isOnHoliday(ctx.instructor, read.date)) {
          await ctx.send(`${firstName(ctx.instructor.name) || "Your instructor"} isn't working on ${formatDay(read.date)}.`);
          await this._askDate(ctx, user, flow);
          return true;
        }
        flow.date = read.date;
        flow.time = read.time && TIME.test(read.time) ? read.time : null;
        this._set(ctx.from, flow);
        if (flow.time) {
          const problem = await this._timeProblem(ctx, user, flow);
          if (problem) {
            await ctx.send(problem);
            flow.time = null;
            this._set(ctx.from, flow);
          } else {
            await this._askConfirm(ctx, flow);
            return true;
          }
        }
        await this._askTime(ctx, user, flow, flow.date);
        return true;
      }
      if (step === "time" && read.time && TIME.test(read.time)) {
        flow.time = read.time;
        this._set(ctx.from, flow);
        const problem = await this._timeProblem(ctx, user, flow);
        if (problem) {
          await ctx.send(problem);
          flow.time = null;
          this._set(ctx.from, flow);
          await this._askTime(ctx, user, flow, flow.date);
        } else {
          await this._askConfirm(ctx, flow);
        }
        return true;
      }
      return false;
    }

    if (step === "confirm") {
      if (YES.test(trimmed)) {
        await this._finish(ctx, user, controller);
        return true;
      }
      if (NO.test(trimmed)) {
        await this._askChange(ctx, flow);
        return true;
      }
      return false;
    }

    return false;
  }

  /** Shows the current step again (after Donna answered a side question). */
  async reprompt(ctx, user, controller) {
    const flow = this.get(ctx.from);
    if (!flow) return;
    flow.awaiting = null;
    this._set(ctx.from, flow);
    switch (flow.step) {
      case "move_what":
        return this._askMoveWhat(ctx, flow);
      case "change":
        return this._askChange(ctx, flow);
      case "confirm":
        return this._askConfirm(ctx, flow);
      case "none":
        return undefined;
      default:
        return this.next(ctx, user, controller);
    }
  }
}

module.exports = new BookingFlow();
