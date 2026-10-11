/**
 * Email address checks for recipients Harbour sends to (inspector pack links, letters by email).
 * Deliberately simple and written as a loop, not a regular expression, so it cannot backtrack on
 * long input (the CodeQL polynomial-ReDoS gate). It catches typing mistakes; it does not prove the
 * address exists, which the one-time code sent to it does.
 */

/** RFC 5321 limits: 254 characters in all, 64 before the "@". */
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;

const FORBIDDEN = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "<",
  ">",
  ",",
  ";",
  '"',
  "(",
  ")",
  "[",
  "]",
  "\\",
]);

/** True for something shaped like local@domain.tld with no spaces or separators. */
export function isPlausibleEmail(value: string | null | undefined): boolean {
  const email = (value ?? "").trim();
  if (email.length < 5 || email.length > MAX_EMAIL_LENGTH) return false;
  for (const ch of email) if (FORBIDDEN.has(ch)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > MAX_LOCAL_PART_LENGTH) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return domain.indexOf(".") > 0;
}

/** Lower case and trimmed, for comparing a recipient with the address a code was sent to. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}
