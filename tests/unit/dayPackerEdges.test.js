/**
 * Smart day packing: edge cases. Learners right next door, learners too far
 * to reach within X, the exact limits, odd settings and awkward calendars,
 * plus a randomised check that every offered start keeps every rule.
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
const learnerAt = (drive, X = 20, V = 5) => (a, b) => {
  if (a.kind === "block" || b.kind === "block") return X;
  return a.isNew || b.isNew ? p.gapFor(drive, X, V) : X;
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
  it("drive + allowance exactly equal to X is allowed, with a gap of X", () => {
    expect(p.gapFor(15, 20, 5)).toBe(20);
  });

  it("even a fraction of a minute over X is refused", () => {
    expect(p.gapFor(15.5, 20, 5)).toBeNull();
    expect(p.gapFor(16, 20, 5)).toBeNull();
  });

  it("with an X that isn't a multiple of 5, starts stay on 5-minute marks and the gap is never short", () => {
    const out = p.candidateStarts({ ...DAY, d: 60, X: 18, items: [lesson("09:00", "10:00")], gap: learnerAt(12, 18) });
    const after = out.filter((s) => s >= t("10:00"));
    expect(after.every((s) => s % 5 === 0)).toBe(true);
    expect(Math.min(...after) - t("10:00")).toBeGreaterThanOrEqual(17);
  });
});

describe("learners too far to reach within X", () => {
  it("aren't offered next to a lesson, before or after it", () => {
    const out = starts({ items: [lesson("12:00", "13:00")], gap: learnerAt(30) });
    expect(out).toEqual([]);
  });

  it("are offered on a day with no lessons", () => {
    expect(starts({ items: [], gap: learnerAt(30) }).length).toBeGreaterThan(0);
  });

  it("are offered next to calendar events, which have no location", () => {
    const out = starts({ items: [block("08:00", "12:00")], gap: learnerAt(30) });
    expect(out).toContain("12:20");
  });

  it("an unknown drive time counts as X, never as close", () => {
    expect(p.gapFor(null, 20, 5)).toBe(20);
    expect(p.gapFor(NaN, 20, 5)).toBe(20);
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
      const X = 12 + Math.floor(rand() * 34);
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
      const drives = items.map(() => (rand() < 0.1 ? null : Math.floor(rand() * 50)));
      const gap = (a, b) => {
        if (a.kind === "block" || b.kind === "block") return X;
        const other = a.isNew ? b : a;
        return other.isNew ? X : p.gapFor(drives[other.id], X, V);
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
      }
    }
  });
});
