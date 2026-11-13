// Checks for the details learners give when signing up (WhatsApp or Portal).
// Each parser returns { value } when the answer is usable, or { error } with
// the reason it isn't.

const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

// Things people send at the name question that aren't names
const NOT_A_NAME = new Set([
  "hi", "hello", "hey", "hiya", "yo", "morning", "afternoon", "evening", "yes", "yeah", "yep", "no", "nope", "ok", "okay",
  "thanks", "thank", "cheers", "help", "menu", "start", "stop", "cancel", "book", "booking", "lesson", "lessons",
  "driving", "want", "need", "please", "test", "what", "why", "how", "when", "who", "can", "price", "prices",
]);

function titleCase(name) {
  return name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

function parseName(input) {
  let name = String(input || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .trim()
    .replace(/^(hi|hello|hey|hiya)[,!.\s]+/i, "")
    .replace(/^(my name is|my name's|name is|name:|i am|i'm|im|it's|its|this is)\s+/i, "")
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) return { error: "empty" };
  if (name.length < 2 || name.length > 60) return { error: "length" };
  if (!/^\p{L}[\p{L}' .-]*$/u.test(name)) return { error: "characters" };
  const words = name.split(" ");
  if (words.length > 5) return { error: "too_many_words" };
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase().replace(/[^\p{L}]/gu, "")))) return { error: "not_a_name" };

  // Keep deliberate capitals (McDonald), tidy all-lower or all-caps
  if (name === name.toLowerCase() || name === name.toUpperCase()) name = titleCase(name);
  return { value: name };
}

function parseAge(input) {
  const numbers = String(input || "").match(/\d+/g) || [];
  if (numbers.length !== 1) return { error: "not_a_number" };
  const age = Number(numbers[0]);
  if (age < 1 || age > 99) return { error: "out_of_range" };
  if (age < 16) return { error: "too_young", value: age };
  return { value: age };
}

function parsePostcode(input) {
  const match = String(input || "").toUpperCase().match(UK_POSTCODE);
  if (!match) return { error: "format" };
  return { value: `${match[1]} ${match[2]}` };
}

module.exports = { parseName, parseAge, parsePostcode };
