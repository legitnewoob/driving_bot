const crypto = require("crypto");

/**
 * The `state` we hand Google when an instructor connects their calendar. Signed
 * with JWT_SECRET and short-lived, so the callback can trust which account the
 * calendar belongs to: nobody can make one up for someone else's account.
 */
const TTL_SECONDS = 15 * 60;

function sign(body) {
  return crypto.createHmac("sha256", process.env.JWT_SECRET || "").update(body).digest("base64url");
}

function createState(instructorId) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
  const body = Buffer.from(
    JSON.stringify({ i: String(instructorId), n: crypto.randomBytes(8).toString("hex"), e: Math.floor(Date.now() / 1000) + TTL_SECONDS })
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The instructor id inside a valid, unexpired state, or null. */
function readState(state) {
  if (!process.env.JWT_SECRET || typeof state !== "string") return null;
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.i || !data.e || data.e < Math.floor(Date.now() / 1000)) return null;
    return data.i;
  } catch {
    return null;
  }
}

module.exports = { createState, readState };
