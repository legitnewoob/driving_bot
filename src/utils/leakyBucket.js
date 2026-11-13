// Leaky-bucket rate limit per key: each allowed hit adds one to the key's
// bucket, which drains by one every `leakMs`. A hit is refused while the
// bucket is full, so a burst of `capacity` goes through, then one per `leakMs`.
class LeakyBucket {
  constructor({ capacity, leakMs }) {
    this.capacity = capacity;
    this.leakMs = leakMs;
    this.buckets = new Map(); // key → { level, at }
  }

  _level(key, now) {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const level = Math.max(0, b.level - (now - b.at) / this.leakMs);
    if (level === 0) this.buckets.delete(key);
    return level;
  }

  take(key, now = Date.now()) {
    const level = this._level(key, now);
    if (level + 1 > this.capacity) return false;
    this.buckets.set(key, { level: level + 1, at: now });
    // Drained buckets are dropped as they're seen; sweep now and then so idle keys don't pile up
    if (this.buckets.size > 1000) for (const k of [...this.buckets.keys()]) this._level(k, now);
    return true;
  }

  clear() {
    this.buckets.clear();
  }
}

module.exports = LeakyBucket;
