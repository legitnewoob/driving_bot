const LeakyBucket = require("../../src/utils/leakyBucket");

describe("LeakyBucket", () => {
  it("lets a burst through, then one per leak interval", () => {
    const bucket = new LeakyBucket({ capacity: 3, leakMs: 1000 });
    expect([0, 0, 0, 0].map((t) => bucket.take("a", t))).toEqual([true, true, true, false]);
    expect(bucket.take("a", 999)).toBe(false);
    expect(bucket.take("a", 1000)).toBe(true);
    expect(bucket.take("a", 1001)).toBe(false);
  });

  it("keeps each key separate and forgets drained ones", () => {
    const bucket = new LeakyBucket({ capacity: 1, leakMs: 1000 });
    expect(bucket.take("a", 0)).toBe(true);
    expect(bucket.take("b", 0)).toBe(true);
    expect(bucket.take("a", 500)).toBe(false);
    expect(bucket.take("a", 5000)).toBe(true);
    bucket._level("b", 5000);
    expect(bucket.buckets.has("b")).toBe(false);
  });
});
