/**
 * Strip MongoDB operators from everything a request sends (body, query, params).
 * Keys starting with "$" (e.g. { "email": { "$ne": null } }) could otherwise turn
 * a lookup into "match anything" wherever request data reaches a query, and
 * dotted keys could reach into nested fields. Our own code builds operators
 * itself; clients never need to send them.
 */
function clean(value, depth = 0) {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("$") || k.includes(".") || k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return value;
}

function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) req.body = clean(req.body);
  // req.query is a getter in newer Express; replace its contents in place
  if (req.query && typeof req.query === "object") {
    const q = clean(req.query);
    for (const k of Object.keys(req.query)) delete req.query[k];
    Object.assign(req.query, q);
  }
  next();
}

module.exports = sanitizeInput;
module.exports.clean = clean;
