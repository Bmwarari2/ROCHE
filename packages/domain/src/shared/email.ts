/**
 * Email address checks for recipients Harbour sends to (inspector pack links, letters by email).
 * Deliberately simple and written as a loop, not a regular expression, so it cannot backtrack on
 * long input (the CodeQL polynomial-ReDoS gate). It catches typing mistakes; it does not prove the
 * address exists, which the one-time code sent to it does.
 *
 * Addresses are printable ASCII only. Non-ASCII letters can look like ASCII ones (a Cyrillic "а"
 * for a Latin "a") and some fold to ASCII when lower-cased (the Kelvin sign becomes "k"), so an
 * address that looks like the recipient's could compare equal to it, or not, depending on the
 * code path. Refusing them keeps one address one string.
 */

/** RFC 5321 limits: 254 characters in all, 64 before the "@". */
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;

const FORBIDDEN = new Set([",", ";", '"', "(", ")", "[", "]", "\\", "<", ">"]);

/** Printable ASCII other than space: "!" (0x21) to "~" (0x7E). */
function isPrintableAscii(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return ch.length === 1 && code >= 0x21 && code <= 0x7e;
}

/** True for something shaped like local@domain.tld, printable ASCII, with no separators. */
export function isPlausibleEmail(value: string | null | undefined): boolean {
  const email = (value ?? "").trim();
  if (email.length < 5 || email.length > MAX_EMAIL_LENGTH) return false;
  for (const ch of email) if (!isPrintableAscii(ch) || FORBIDDEN.has(ch)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > MAX_LOCAL_PART_LENGTH) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return domain.indexOf(".") > 0;
}

/**
 * Trimmed, with ASCII capitals lowered one by one (never `toLowerCase`, which also folds other
 * scripts), for comparing a recipient with the address a code was sent to.
 */
export function normaliseEmail(value: string): string {
  let out = "";
  for (const ch of value.trim()) {
    const code = ch.charCodeAt(0);
    out += ch.length === 1 && code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : ch;
  }
  return out;
}
