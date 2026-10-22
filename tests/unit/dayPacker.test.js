const p = require("../../src/services/dayPacker");

const hm = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const LUNCH = { durationMin: 45, from: hm("12:00"), to: hm("14:00") };
const DAY = { start: hm("08:00"), end: hm("18:00") };
const lesson = (start, d, extra = {}) => ({ start: hm(start), end: hm(start) + d, kind: "lesson", ...extra });
const constantGap = (X) => () => X;

describe("gapFor", () => {
  it("adds the variance to the drive and rounds up to 5 minutes", () => {
    expect(p.gapFor(8, 20, 5)).toBe(15);
    expect(p.gapFor(10, 20, 5)).toBe(15);
    expect(p.gapFor(0, 20, 5)).toBe(5);
  });

  it("never goes past X because of rounding", () => {
    expect(p.gapFor(13, 18, 5)).toBe(18);
  });

  it("is null when drive + variance is over X", () => {
    expect(p.gapFor(15, 18, 5)).toBeNull();
    expect(p.gapFor(25, 20, 5)).toBeNull();
  });

  it("uses X when the drive is unknown", () => {
    expect(p.gapFor(null, 20, 5)).toBe(20);
    expect(p.gapFor(undefined, 20, 5)).toBe(20);
    expect(p.gapFor(NaN, 20, 5)).toBe(20);
  });

  it("with no variance uses the drive itself", () => {
    expect(p.gapFor(12, 20, 0)).toBe(15);
    expect(p.gapFor(20, 20, 0)).toBe(20);
  });
});

describe("packEmptyDay", () => {
  it("fits 7 one-hour lessons in 08:00–18:00 with X = 15 and a 45-minute lunch", () => {
    const day = p.packEmptyDay({ ...DAY, d: 60, X: 15, lunch: LUNCH });
    expect(day.count).toBe(7);
    expect(day.starts.map(fmt)).toEqual(["08:00", "09:15", "10:30", "11:45", "13:45", "15:00", "16:15"]);
    expect(fmt(day.lunch.from)).toBe("12:45");
    expect(fmt(day.lunch.to)).toBe("13:30");
  });

  it("drives to the first lesson after lunch (X after the break)", () => {
    const day = p.packEmptyDay({ ...DAY, d: 60, X: 15, lunch: LUNCH });
    const firstAfter = day.starts.find((s) => s >= day.lunch.to);
    expect(firstAfter - day.lunch.to).toBeGreaterThanOrEqual(15);
  });

  it.each([
    [60, 7],
    [90, 5],
    [120, 4],
  ])("packs %i-minute lessons (X = 12): %i a day", (d, count) => {
    expect(p.packEmptyDay({ ...DAY, d, X: 12, lunch: LUNCH }).count).toBe(count);
  });

  it("a bigger X fits fewer lessons", () => {
    const tight = p.packEmptyDay({ ...DAY, d: 60, X: 12, lunch: LUNCH }).count;
    const relaxed = p.packEmptyDay({ ...DAY, d: 60, X: 45, lunch: LUNCH }).count;
    expect(relaxed).toBeLessThan(tight);
    expect(relaxed).toBe(5);
  });

  it("every gap is at least X and lessons never overlap", () => {
    for (const d of [60, 90, 120]) {
      for (const X of [12, 17, 20, 33, 45]) {
        const { starts, lunch } = p.packEmptyDay({ ...DAY, d, X, lunch: LUNCH });
        for (let i = 1; i < starts.length; i++) {
          const gap = starts[i] - (starts[i - 1] + d);
          const lunchBetween = lunch && lunch.from >= starts[i - 1] + d && lunch.to <= starts[i];
          expect(gap).toBeGreaterThanOrEqual(lunchBetween ? lunch.to - lunch.from + X : X);
        }
        expect(starts.every((s) => s % 5 === 0)).toBe(true);
        expect(starts[starts.length - 1] + d).toBeLessThanOrEqual(DAY.end);
        if (lunch) {
          expect(lunch.from).toBeGreaterThanOrEqual(LUNCH.from);
          expect(lunch.to).toBeLessThanOrEqual(LUNCH.to);
          expect(starts.some((s) => s < lunch.to && s + d > lunch.from)).toBe(false);
        }
      }
    }
  });

  it("with lunch off, lessons run straight through", () => {
    const day = p.packEmptyDay({ ...DAY, d: 60, X: 15, lunch: null });
    expect(day.count).toBe(8);
    expect(day.lunch).toBeNull();
  });

  it("a lunch window outside the working day isn't needed", () => {
    const day = p.packEmptyDay({ start: hm("15:00"), end: hm("20:00"), d: 60, X: 15, lunch: LUNCH });
    expect(day.lunch).toBeNull();
    expect(day.count).toBe(4);
  });

  it("a window too short for the lunch means no lunch", () => {
    const day = p.packEmptyDay({ ...DAY, d: 60, X: 15, lunch: { durationMin: 60, from: hm("12:00"), to: hm("12:30") } });
    expect(day.lunch).toBeNull();
  });

  it("a day too short for any lesson has none", () => {
    expect(p.packEmptyDay({ start: hm("09:00"), end: hm("09:45"), d: 60, X: 15, lunch: null }).count).toBe(0);
  });

  it("fixed breaks split the day and need a drive after them", () => {
    const day = p.packEmptyDay({ ...DAY, d: 60, X: 15, lunch: null, blocks: [{ start: hm("10:00"), end: hm("11:00"), kind: "block" }] });
    expect(day.starts.some((s) => s < hm("11:00") && s + 60 > hm("10:00"))).toBe(false);
    expect(day.starts).toContain(hm("11:15"));
  });
});

describe("candidateStarts", () => {
  it("on an empty day offers the packed starts", () => {
    const starts = p.candidateStarts({ ...DAY, d: 60, X: 15, lunch: LUNCH, items: [], gap: constantGap(15) });
    for (const s of ["08:00", "09:15", "10:30", "11:45", "13:45", "15:00", "16:15"]) {
      expect(starts).toContain(hm(s));
    }
  });

  it("a nearby learner starts sooner than X after the lesson before", () => {
    // 8 min drive + 5 variance → 15 min gap, while X is 20
    const items = [lesson("09:00", 60, { id: "a" })];
    const gap = (a, b) => (a.id === "a" && b.isNew ? p.gapFor(8, 20, 5) : 20);
    const starts = p.candidateStarts({ ...DAY, d: 60, X: 20, lunch: null, items, gap });
    expect(starts).toContain(hm("10:15"));
    expect(starts).not.toContain(hm("10:05"));
  });

  it("real gaps fit more lessons than the worst-case day", () => {
    const worst = p.packEmptyDay({ ...DAY, d: 60, X: 30, lunch: null }).count;
    // Learners all 5 minutes apart: each lesson can follow 10 minutes after the last
    let items = [];
    const gap = () => p.gapFor(5, 30, 5);
    for (;;) {
      const next = p.candidateStarts({ ...DAY, d: 60, X: 30, lunch: null, items, gap }).find((s) => !items.length || s >= items[items.length - 1].end);
      if (next === undefined) break;
      items = [...items, { start: next, end: next + 60, kind: "lesson" }];
    }
    expect(items.length).toBeGreaterThan(worst);
  });

  it("doesn't offer a start when the drive plus variance is over X", () => {
    const items = [lesson("09:00", 60, { id: "a" })];
    const gap = (a, b) => (a.id === "a" && b.isNew ? p.gapFor(15, 18, 5) : 18);
    const starts = p.candidateStarts({ start: hm("08:00"), end: hm("12:00"), d: 60, X: 18, lunch: null, items, gap });
    // Nothing straight after the 09:00 lesson; only before it
    expect(starts.filter((s) => s >= hm("10:00"))).toEqual([]);
    expect(starts.every((s) => s + 60 <= hm("09:00"))).toBe(true);
  });

  it("leaves room for the drive to the next lesson", () => {
    const items = [lesson("11:00", 60)];
    const starts = p.candidateStarts({ ...DAY, d: 60, X: 20, lunch: null, items, gap: constantGap(20) });
    expect(starts).toContain(hm("09:40")); // ends 10:40, 20 min before 11:00
    expect(starts).not.toContain(hm("09:45"));
  });

  it("packs around lessons of other lengths", () => {
    const items = [lesson("09:00", 120), lesson("13:00", 90)];
    const starts = p.candidateStarts({ ...DAY, d: 60, X: 15, lunch: null, items, gap: constantGap(15) });
    for (const s of starts) {
      for (const it of items) expect(s < it.end + 15 && s + 60 + 15 > it.start).toBe(false);
    }
    expect(starts).toContain(hm("11:15"));
  });

  it("drops a start that would leave no room for lunch", () => {
    // 11:00–12:00 and 13:30–14:30 booked: lunch can go 12:00–12:45 (X = 15 before 13:30)
    const items = [lesson("11:00", 60), lesson("13:30", 60)];
    const starts = p.candidateStarts({ ...DAY, d: 60, X: 15, lunch: LUNCH, items, gap: constantGap(15) });
    expect(starts.some((s) => s >= hm("12:00") && s < hm("13:30"))).toBe(false);
  });

  it("keeps offering starts when lunch already couldn't fit", () => {
    // Booked solid through the whole lunch window
    const items = [lesson("11:30", 150)];
    const starts = p.candidateStarts({ ...DAY, d: 60, X: 15, lunch: LUNCH, items, gap: constantGap(15) });
    expect(starts.length).toBeGreaterThan(0);
  });

  it("calendar blocks are avoided too", () => {
    const items = [{ start: hm("10:00"), end: hm("12:00"), kind: "block" }];
    const starts = p.candidateStarts({ ...DAY, d: 60, X: 15, lunch: null, items, gap: constantGap(15) });
    expect(starts.some((s) => s < hm("12:15") && s + 60 > hm("09:45"))).toBe(false);
  });

  it("every start is on a 5-minute mark", () => {
    const items = [lesson("09:07", 60)];
    const starts = p.candidateStarts({ ...DAY, d: 90, X: 17, lunch: LUNCH, items, gap: constantGap(17) });
    expect(starts.every((s) => s % 5 === 0)).toBe(true);
  });
});

describe("isStartFeasible", () => {
  const args = { ...DAY, d: 60, X: 20, lunch: LUNCH, gap: constantGap(20) };

  it("accepts a time that fits even if it isn't an offered start", () => {
    expect(p.isStartFeasible({ ...args, items: [], s: hm("10:05") })).toBe(true);
  });

  it("rejects overlaps, short gaps, off-grid times and times outside the day", () => {
    const items = [lesson("10:00", 60)];
    expect(p.isStartFeasible({ ...args, items, s: hm("10:30") })).toBe(false);
    expect(p.isStartFeasible({ ...args, items, s: hm("11:10") })).toBe(false);
    expect(p.isStartFeasible({ ...args, items, s: hm("11:20") })).toBe(true);
    expect(p.isStartFeasible({ ...args, items: [], s: hm("10:03") })).toBe(false);
    expect(p.isStartFeasible({ ...args, items: [], s: hm("17:30") })).toBe(false);
    expect(p.isStartFeasible({ ...args, items: [], s: hm("07:30") })).toBe(false);
  });
});

describe("lunchFits / placeLunch", () => {
  it("finds the earliest place lunch fits", () => {
    const items = [lesson("11:00", 90)];
    const where = p.placeLunch({ ...DAY, X: 15, lunch: LUNCH, items, gap: constantGap(15) });
    expect(fmt(where.from)).toBe("12:30");
    expect(p.lunchFits({ ...DAY, X: 15, lunch: LUNCH, items, gap: constantGap(15) })).toBe(true);
  });

  it("needs the drive to the next lesson after lunch", () => {
    // 12:00–12:45 lunch would need to leave by 12:45 for a 13:00 lesson with X = 30
    const items = [lesson("11:00", 60), lesson("13:00", 60), lesson("14:15", 60)];
    expect(p.lunchFits({ ...DAY, X: 30, lunch: LUNCH, items, gap: constantGap(30) })).toBe(false);
    expect(p.lunchFits({ ...DAY, X: 15, lunch: LUNCH, items, gap: constantGap(15) })).toBe(true);
  });
});
