/**
 * Smart day packing: edge cases. Learners right next door, learners further
 * than the usual gap (X) and further than the longest drive (H), the exact
 * limits, quiet and busy days, odd settings and awkward calendars, plus a
 * randomised check that every offered start keeps every rule.
 */

const p = require("../../src/services/dayPacker");

const t = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const lesson = (from, to, extra = {}) => ({ start: t(from), end: t(to), kind: "lesson", ...extra });
const block = (from, to) => ({ start: t(from), end: t(to), kind: "block" });
const DAY = { start: t("08:00"), end: t("18:00") };

// A gap callback where the learner being placed is `drive` minutes from every lesson
const learnerAt = (drive, X = 20, V = 5, H = 40) => (a, b) => {
  if (a.kind === "block" || b.kind === "block") return X;
  return a.isNew || b.isNew ? p.gapFor(drive, X, V, H) : X;
};
const starts = (args) => p.candidateStarts({ ...DAY, d: 60, X: 20, ...args }).map(hm);

describe("learners who are very close", () => {
  it("the same address as the last drop-off still leaves the 5-minute allowance", () => {
    expect(p.gapFor(0, 20, 5)).toBe(5);
  });

  it("with the allowance set to 0, the same address can be back to back", () => {
    expect(p.gapFor(0, 20, 0)).toBe(0);
    expect(starts({ items: [lesson("09:00", "10:00")], gap: learnerAt(0, 20, 0) })).toContain("10:00");
  });

  it("a learner 1 minute away starts 10 minutes after (1 + 5, rounded up to 5)", () => {
    expect(p.gapFor(1, 20, 5)).toBe(10);
    expect(starts({ items: [lesson("09:00", "10:00")], gap: learnerAt(1) })).toContain("10:10");
  });

  it("a close learner fits a gap between two lessons that the full X couldn't", () => {
    const items = [lesson("09:00", "10:00"), lesson("11:10", "12:10")];
    expect(starts({ items, gap: learnerAt(0) })).toContain("10:05");
    expect(starts({ items, gap: () => 20 }).filter((s) => s > "10:00" && s < "11:10")).toEqual([]);
  });

  it("never offers a start that overlaps a lesson, however close the learner is", () => {
    const out = starts({ items: [lesson("09:00", "10:00")], gap: learnerAt(0, 20, 0) });
    expect(out.some((s) => s > "08:00" && s < "10:00")).toBe(false);
  });
});

describe("learners at the limit", () => {
  it("a drive up to X is never refused; the variance shrinks so the gap stays at X", () => {
    expect(p.gapFor(15, 20, 5, 40)).toBe(20);
    expect(p.gapFor(18, 20, 5, 40)).toBe(20);
    expect(p.gapFor(20, 20, 5, 40)).toBe(20);
  });

  it("a drive up to X next to a lesson is offered, however busy the day", () => {
    const items = [lesson("09:00", "10:00"), lesson("11:40", "12:40"), lesson("13:00", "14:00"), lesson("14:20", "15:20")];
    expect(starts({ items, gap: learnerAt(18, 20, 5) })).toContain("10:20");
  });

  it("past X the variance is added in full", () => {
    expect(p.gapFor(21, 20, 5, 40)).toBe(30);
  });

  it("exactly the longest drive (H) is allowed; a fraction over is refused", () => {
    expect(p.gapFor(40, 20, 5, 40)).toBe(45);
    expect(p.gapFor(40.5, 20, 5, 40)).toBeNull();
  });

  it("with an X that isn't a multiple of 5, starts stay on 5-minute marks and the gap is never short", () => {
    const out = p.candidateStarts({ ...DAY, d: 60, X: 18, items: [lesson("09:00", "10:00")], gap: learnerAt(12, 18) });
    const after = out.filter((s) => s >= t("10:00"));
    expect(after.every((s) => s % 5 === 0)).toBe(true);
    expect(Math.min(...after) - t("10:00")).toBeGreaterThanOrEqual(17);
  });
});

// A learner `drive` minutes from every lesson and from the instructor's base,
// as the route optimiser would see them (learners who haven't booked yet are
// assumed to live near the base)
const farLearner = (drive, X = 20, H = 40, V = 5) => (a, b) => {
  if (a.isUnknown || b.isUnknown) {
    const other = a.isUnknown ? b : a;
    if (!other.isNew) return X;
    return Math.max(X, p.gapFor(drive, X, V)); // a guess, so the longest drive doesn't apply
  }
  if (a.kind === "block" || b.kind === "block") return X;
  return a.isNew || b.isNew ? p.gapFor(drive, X, V, H) : X;
};

describe("far learners: drive between X and the longest drive (H)", () => {
  const L = lesson;

  it("on an empty day every time is offered", () => {
    expect(starts({ items: [], gap: farLearner(30) })).toEqual(starts({ items: [], gap: () => 20 }));
  });

  it("on a quiet day (one lesson at 09:00) they're fitted in, after the full drive", () => {
    const out = starts({ items: [L("09:00", "10:00")], gap: farLearner(30) });
    expect(out[0]).toBe("10:35"); // 30 min drive + 5, after 10:00
    expect(out).toContain("17:00");
  });

  it("on a busy day they don't take a local learner's place", () => {
    const items = [L("09:00", "10:00"), L("10:20", "11:20"), L("11:40", "12:40"), L("13:00", "14:00")];
    expect(starts({ items, gap: farLearner(30) })).toEqual([]);
  });

  it("on a busy day they still get a time that costs nothing", () => {
    // Booked solid until 16:40: the far learner at the end of the day loses nobody a slot
    const items = [L("08:00", "09:00"), L("09:20", "10:20"), L("10:40", "11:40"), L("12:00", "13:00"), L("13:20", "14:20"), L("14:40", "15:40")];
    const out = starts({ items, gap: farLearner(30) });
    expect(out).toContain("16:15");
  });

  it("every offered time costs the day no lesson, or one on a quiet day", () => {
    const days = [[], [L("09:00", "10:00")], [L("09:00", "10:00"), L("12:00", "13:00")], [L("08:00", "09:00"), L("14:00", "15:00"), L("16:20", "17:20")]];
    for (const items of days) {
      const args = { ...DAY, d: 60, X: 20, items, gap: farLearner(30) };
      const before = p.capacity(args);
      const allowance = items.length < before / 2 ? 1 : 0;
      for (const s of p.candidateStarts(args)) {
        const after = p.capacity({ ...args, items: [...items, { start: s, end: s + 60, kind: "lesson", isNew: true }] });
        expect([hm(s), after >= before - allowance]).toEqual([hm(s), true]);
      }
    }
  });

  it("the daily lesson limit counts: a long drive is fine when the day can't take more anyway", () => {
    const items = [L("09:00", "10:00"), L("10:20", "11:20"), L("11:40", "12:40"), L("13:00", "14:00")];
    expect(starts({ items, gap: farLearner(30), maxLessons: 5 })).not.toEqual([]);
  });

  it("a typed time follows the same rule as the offered ones", () => {
    const busy = [L("09:00", "10:00"), L("10:20", "11:20"), L("11:40", "12:40"), L("13:00", "14:00")];
    expect(p.isStartFeasible({ ...DAY, d: 60, X: 20, items: busy, gap: farLearner(30), s: t("14:35") })).toBe(false);
    expect(p.isStartFeasible({ ...DAY, d: 60, X: 20, items: [L("09:00", "10:00")], gap: farLearner(30), s: t("10:35") })).toBe(true);
  });
});

describe("learners further than the longest drive (H)", () => {
  it("aren't offered next to a lesson, before or after it", () => {
    expect(starts({ items: [lesson("12:00", "13:00")], gap: farLearner(50) })).toEqual([]);
  });

  it("are offered on a day with no lessons", () => {
    expect(starts({ items: [], gap: farLearner(50) }).length).toBeGreaterThan(0);
  });

  it("are offered next to calendar events, which have no location", () => {
    expect(starts({ items: [block("08:00", "12:00")], gap: learnerAt(50, 20, 5) })).toContain("12:20");
  });

  it("an unknown drive time counts as X, never as close or far", () => {
    expect(p.gapFor(null, 20, 5, 40)).toBe(20);
    expect(p.gapFor(NaN, 20, 5, 40)).toBe(20);
  });
});

describe("awkward calendars", () => {
  it("a lesson inside a longer calendar event doesn't hide the time after the event", () => {
    const items = [block("10:00", "14:00"), lesson("11:00", "12:00")];
    const out = starts({ items, gap: () => 20 });
    expect(out).toContain("14:20");
    expect(out.some((s) => s >= "10:00" && s < "14:20")).toBe(false);
  });

  it("lunch doesn't count as fitting inside a calendar event that covers a lesson", () => {
    const lunch = { durationMin: 45, from: t("12:00"), to: t("14:00") };
    const items = [block("11:00", "15:00"), lesson("12:00", "13:00")];
    expect(p.lunchFits({ ...DAY, X: 20, lunch, items, gap: () => 20 })).toBe(false);
    expect(p.placeLunch({ ...DAY, X: 20, lunch, items, gap: () => 20 })).toBeNull();
  });

  it("a lesson can end exactly at the end of the day, but not after it", () => {
    const out = starts({ items: [], gap: () => 20 });
    expect(out).toContain("17:00");
    expect(out.some((s) => s > "17:00")).toBe(false);
  });

  it("nothing is offered when the free time is a few minutes short of a lesson", () => {
    const items = [lesson("08:00", "12:00"), lesson("13:35", "18:00")];
    // 12:00 + 20 drive = 12:20, + 60 = 13:20, + 20 drive = 13:40 > 13:35
    expect(starts({ items, gap: () => 20 })).toEqual([]);
  });

  it("lessons booked on top of each other (from before packing) don't produce overlapping offers", () => {
    const items = [lesson("09:00", "11:00"), lesson("10:00", "11:00")];
    const out = p.candidateStarts({ ...DAY, d: 60, X: 20, items, gap: () => 20 });
    expect(out.every((s) => !items.some((it) => s < it.end && s + 60 > it.start))).toBe(true);
  });
});

describe("every offered start keeps every rule (randomised days)", () => {
  // Small seeded generator so a failure can be replayed
  function rng(seed) {
    let x = seed;
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
  }

  it("1,000 random days", () => {
    const rand = rng(42);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    for (let n = 0; n < 1000; n++) {
      const X = 10 + Math.floor(rand() * 30);
      const H = X + Math.floor(rand() * 30);
      const V = pick([0, 5, 10]);
      const d = pick([60, 90, 120]);
      const lunch = rand() < 0.7 ? { durationMin: pick([30, 45, 60]), from: t("12:00"), to: t("14:00") } : null;

      // A few non-overlapping lessons and maybe a calendar event
      const items = [];
      let cursor = DAY.start + Math.floor(rand() * 120);
      while (cursor < DAY.end - 60 && items.length < 5) {
        const len = pick([60, 90, 120]);
        if (cursor + len > DAY.end) break;
        items.push({ start: cursor, end: cursor + len, kind: rand() < 0.15 ? "block" : "lesson", id: items.length });
        cursor += len + Math.floor(rand() * 180);
      }

      // Each lesson is a random drive from the learner; some are unknown, some far
      const drives = items.map(() => (rand() < 0.1 ? null : Math.floor(rand() * 70)));
      const learnerToBase = rand() < 0.2 ? null : Math.floor(rand() * 60);
      const gap = (a, b) => {
        if (a.isUnknown || b.isUnknown) {
          const other = a.isUnknown ? b : a;
          if (!other.isNew) return X;
          return Math.max(X, p.gapFor(learnerToBase, X, V));
        }
        if (a.kind === "block" || b.kind === "block") return X;
        const other = a.isNew ? b : a;
        return other.isNew ? X : p.gapFor(drives[other.id], X, V, H);
      };

      const args = { ...DAY, d, X, lunch, items, gap };
      const lunchBefore = lunch && p.lunchFits(args);
      for (const s of p.candidateStarts(args)) {
        const where = `day ${n}, start ${hm(s)}`;
        expect([where, s % 5]).toEqual([where, 0]);
        expect([where, s >= DAY.start && s + d <= DAY.end]).toEqual([where, true]);
        expect([where, items.some((it) => s < it.end && s + d > it.start)]).toEqual([where, false]);

        const prev = items.filter((it) => it.end <= s).sort((a, b) => b.end - a.end)[0];
        const next = items.filter((it) => it.start >= s + d).sort((a, b) => a.start - b.start)[0];
        if (prev) {
          const g = gap(prev, p.NEW);
          expect([where, g !== null && prev.end + g <= s]).toEqual([where, true]);
          if (prev.kind === "lesson" && drives[prev.id] != null) expect([where, drives[prev.id] <= H]).toEqual([where, true]);
        }
        if (next) {
          const g = gap(p.NEW, next);
          expect([where, g !== null && s + d + g <= next.start]).toEqual([where, true]);
        }
        if (lunchBefore) {
          const withIt = [...items, { start: s, end: s + d, kind: "lesson", isNew: true }];
          expect([where, p.lunchFits({ ...args, items: withIt })]).toEqual([where, true]);
        }
        expect([where, p.isStartFeasible({ ...args, s })]).toEqual([where, true]);
        expect([where, p.longDriveAllowed(args, s)]).toEqual([where, true]);
      }
    }
  });
});
