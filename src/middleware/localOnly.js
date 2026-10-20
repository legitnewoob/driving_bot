/**
 * Dev tools (the WhatsApp mock, the email outbox) only answer requests from
 * this machine. A server that happens to run with NODE_ENV=development (as UAT
 * can) still won't expose them to the internet: anything that came through a
 * proxy or from another address is refused.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function localOnly(req, res, next) {
  const direct = req.socket?.remoteAddress;
  const proxied = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["forwarded"];
  if (LOOPBACK.has(direct) && !proxied) return next();
  return res.status(404).send("Not found");
}

module.exports = localOnly;
