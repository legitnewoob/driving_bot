/**
 * Times are stored and passed around as 24-hour "HH:MM". Use this only when
 * showing a time to a person: "14:30" → "2:30 pm", "09:00" → "9:00 am".
 * Anything that isn't a valid HH:MM is returned unchanged.
 */
function to12h(time) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time ?? "").trim());
  if (!m) return time;
  const hours = Number(m[1]);
  const suffix = hours < 12 ? "am" : "pm";
  return `${hours % 12 || 12}:${m[2]} ${suffix}`;
}

module.exports = { to12h };
