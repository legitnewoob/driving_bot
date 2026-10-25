// Packs a working day with lessons. Pure maths, no I/O: every time is in
// minutes after midnight and every gap comes from a callback, so the route
// optimiser can feed in real drive times and the dashboard preview can use X.
//
// Rules (see SMART-DAY-PACKING-PLAN.md):
// - After each lesson the instructor needs a gap to drive to the next one.
//   The gap is at most X; with a known drive it is drive + variance, rounded
//   up to 5 minutes. If drive + variance is over X the lesson isn't offered.
// - Lunch is a flexible window: a break of B minutes anywhere inside
//   [from, to]. Driving to the first lesson after lunch comes after it.
// - Start times are on 5-minute marks.

const NEW = Object.freeze({ isNew: true });
const MAX_LESSONS = 50;

const roundUp5 = (m) => Math.ceil(m / 5) * 5;
const roundDown5 = (m) => Math.floor(m / 5) * 5;

/**
 * Minutes to leave between two lessons for a drive, or null if the drive
 * doesn't fit inside X. An unknown drive (no location, API failure) uses X.
 */
function gapFor(drive, X, variance = 5) {
  if (drive == null || !Number.isFinite(drive)) return X;
  const need = drive + variance;
  if (need > X) return null;
  return Math.min(X, roundUp5(need));
}

// Back-to-back lessons from `from`, each followed by an X gap, ending by `to`.
function chain(from, to, d, X) {
  const starts = [];
  let t = roundUp5(from);
  while (t + d <= to && starts.length < MAX_LESSONS) {
    starts.push(t);
    t = roundUp5(t + d + X);
  }
  return starts;
}

/**
 * The most lessons that fit in [from, to] with a lunch somewhere in its window.
 * Tries every number of lessons before lunch and keeps the best; ties go to
 * the lunch nearest the middle of its window. Returns { starts, lunch } where
 * lunch is null when it can't sit in this range at all.
 */
function packRange(from, to, d, X, lunch) {
  const plain = chain(from, to, d, X);
  if (!lunch) return { starts: plain, lunch: null };

  const B = lunch.durationMin;
  const wf = Math.max(lunch.from, from);
  const wt = Math.min(lunch.to, to);
  if (wt - wf < B) return { starts: plain, lunch: null };

  const morningAll = chain(from, wt, d, X);
  const middle = (lunch.from + lunch.to) / 2;
  let best = null;
  for (let a = 0; a <= morningAll.length; a++) {
    const morning = morningAll.slice(0, a);
    const lastEnd = a ? morning[a - 1] + d : from;
    const L = roundUp5(Math.max(wf, lastEnd));
    if (L + B > wt) break;
    const afternoon = chain(L + B + X, to, d, X);
    const count = a + afternoon.length;
    const off = Math.abs(L + B / 2 - middle);
    if (!best || count > best.count || (count === best.count && off < best.off)) {
      best = { count, off, starts: [...morning, ...afternoon], lunch: { from: L, to: L + B } };
    }
  }
  return best ? { starts: best.starts, lunch: best.lunch } : { starts: plain, lunch: null };
}

// Lessons and blocks sorted by start.
const byStart = (a, b) => a.start - b.start || a.end - b.end;

/**
 * The free stretches between sorted items: { prev, next, from, to }. `prev` is
 * whatever finishes last before the stretch, so an item inside a longer one
 * (a lesson during an all-day event) can't open a stretch that isn't free.
 * A stretch can be empty (to <= from); callers skip those.
 */
function stretches(sorted, start, end) {
  const out = [];
  let prev = null;
  for (const next of [...sorted, null]) {
    out.push({
      prev,
      next,
      from: prev ? Math.max(prev.end, start) : start,
      to: next ? Math.min(next.start, end) : end,
    });
    if (next && (!prev || next.end > prev.end)) prev = next;
  }
  return out;
}

/**
 * Whether a lunch of B minutes still fits in its window around these items.
 * Lunch can't overlap anything; a lesson after lunch needs its drive gap
 * (from the previous lesson's drop-off, or X when lunch starts the day).
 */
function lunchFits({ start, end, X, lunch, items, gap }) {
  if (!lunch) return true;
  const B = lunch.durationMin;
  for (const { prev, next, from } of stretches([...items].sort(byStart), start, end)) {
    const open = Math.max(from, lunch.from);
    let after = 0;
    if (next && next.kind === "lesson") {
      after = prev && prev.kind === "lesson" ? gap(prev, next) ?? X : X;
    }
    const close = Math.min(next ? next.start - after : end, lunch.to);
    if (roundUp5(open) + B <= close) return true;
  }
  return false;
}

/** Where lunch would go around these items: the earliest place it fits, or null. */
function placeLunch({ start, end, X, lunch, items, gap }) {
  if (!lunch) return null;
  const B = lunch.durationMin;
  for (const { prev, next, from } of stretches([...items].sort(byStart), start, end)) {
    const open = roundUp5(Math.max(from, lunch.from));
    let after = 0;
    if (next && next.kind === "lesson") {
      after = prev && prev.kind === "lesson" ? gap(prev, next) ?? X : X;
    }
    const close = Math.min(next ? next.start - after : end, lunch.to);
    if (open + B <= close) return { from: open, to: open + B };
  }
  return null;
}

/**
 * Start times a new lesson of `d` minutes could take, around what's already
 * in the day.
 *
 * items: [{ start, end, kind: "lesson" | "block", ... }]. Lessons are booked
 *   lessons; blocks are calendar events and fixed breaks.
 * gap(a, b): minutes needed between `a` ending and `b` starting, or null if b
 *   can't be reached from a in time. Either side may be NEW (the lesson being
 *   placed). Not called for the day's start or end: home legs aren't timed.
 *
 * In each free stretch it offers the earliest start that's snug against the
 * lesson before, the packed run from there (worst case X between unknown
 * learners), the best lunch-aware packing, and the start snug against the
 * lesson after. A start that would leave no room for lunch is dropped, unless
 * lunch already didn't fit.
 */
function candidateStarts({ start, end, d, X, lunch = null, items = [], gap }) {
  const sorted = [...items].sort(byStart);
  const found = new Set();

  for (const { prev, next, from: segStart, to: segEnd } of stretches(sorted, start, end)) {
    if (segEnd - segStart < d) continue;

    const gIn = prev ? gap(prev, NEW) : 0;
    const gOut = next ? gap(NEW, next) : 0;
    if (gIn == null || gOut == null) continue;

    const from = roundUp5(segStart + gIn);
    const to = segEnd - gOut;
    if (from + d > to) continue;

    for (const s of chain(from, to, d, X)) found.add(s);
    for (const s of packRange(from, to, d, X, lunch).starts) found.add(s);
    const latest = roundDown5(to - d);
    if (latest >= from) found.add(latest);
  }

  let starts = [...found].sort((a, b) => a - b);
  // Two lessons can't overlap, even if the day was set up inconsistently
  starts = starts.filter((s) => !sorted.some((it) => s < it.end && s + d > it.start));

  if (lunch && lunchFits({ start, end, X, lunch, items: sorted, gap })) {
    starts = starts.filter((s) =>
      lunchFits({ start, end, X, lunch, items: [...sorted, { start: s, end: s + d, kind: "lesson", isNew: true }], gap })
    );
  }
  return starts;
}

/**
 * Whether a lesson could start at `s` (a time the learner asked for, which may
 * not be one of the offered starts): inside the day, on a 5-minute mark, clear
 * of everything, with the drive gaps either side and room left for lunch.
 */
function isStartFeasible({ s, start, end, d, X, lunch = null, items = [], gap }) {
  if (s % 5 !== 0 || s < start || s + d > end) return false;
  const sorted = [...items].sort(byStart);
  if (sorted.some((it) => s < it.end && s + d > it.start)) return false;
  const prev = [...sorted].reverse().find((it) => it.end <= s);
  const next = sorted.find((it) => it.start >= s + d);
  if (prev) {
    const g = gap(prev, NEW);
    if (g == null || prev.end + g > s) return false;
  }
  if (next) {
    const g = gap(NEW, next);
    if (g == null || s + d + g > next.start) return false;
  }
  if (lunch && lunchFits({ start, end, X, lunch, items: sorted, gap })) {
    return lunchFits({ start, end, X, lunch, items: [...sorted, { start: s, end: s + d, kind: "lesson", isNew: true }], gap });
  }
  return true;
}

/**
 * The guaranteed-minimum day: every drive takes the full X. Fixed blocks
 * (breaks) split the day; lunch goes in whichever stretch loses the fewest
 * lessons. Returns { starts, lunch, count }.
 */
function packEmptyDay({ start, end, d, X, lunch = null, blocks = [] }) {
  const sorted = [...blocks].sort(byStart);
  const segments = [];
  let cursor = start;
  let afterBlock = false;
  for (const b of sorted) {
    if (b.start > cursor) segments.push({ from: afterBlock ? cursor + X : cursor, to: Math.min(b.start, end) });
    cursor = Math.max(cursor, b.end);
    afterBlock = true;
  }
  if (cursor < end) segments.push({ from: afterBlock ? cursor + X : cursor, to: end });

  const plain = segments.map((s) => chain(s.from, s.to, d, X));
  let best = { starts: plain.flat(), lunch: null };

  if (lunch) {
    let bestCount = -1;
    segments.forEach((s, i) => {
      const packed = packRange(s.from, s.to, d, X, lunch);
      if (!packed.lunch) return;
      const starts = plain.flatMap((p, j) => (j === i ? packed.starts : p));
      if (starts.length > bestCount) {
        bestCount = starts.length;
        best = { starts, lunch: packed.lunch };
      }
    });
  }

  const starts = [...best.starts].sort((a, b) => a - b);
  return { starts, lunch: best.lunch, count: starts.length };
}

module.exports = {
  NEW,
  roundUp5,
  roundDown5,
  gapFor,
  chain,
  packRange,
  lunchFits,
  placeLunch,
  candidateStarts,
  isStartFeasible,
  packEmptyDay,
};
