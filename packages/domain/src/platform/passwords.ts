/**
 * NCSC password guidance (section 5.3): length over complexity, a deny-list of common and
 * context-specific passwords, no composition rules and no forced expiry. Shared by the API, which
 * enforces it, and the web, which checks it before sending so the person sees the same reason at
 * the field. The list is deliberately small and local: no password material ever leaves Harbour.
 */

/** The least number of characters a password may have. */
export const PASSWORD_MIN_LENGTH = 12;
/** The most the API accepts (`AcceptInvitation`). */
export const PASSWORD_MAX_LENGTH = 128;

const COMMON = new Set([
  "password1234",
  "password12345",
  "passwordpassword",
  "123456789012",
  "qwertyuiopas",
  "iloveyou1234",
  "welcome12345",
  "letmein12345",
  "harbourcare1",
  "harbourharbour",
  "carehome1234",
  "carehomecare",
  "nursingcare1",
  "changeme1234",
  "administrator",
]);

const CONTEXT_WORDS = ["harbour", "thapsus", "password", "carehome", "qwerty", "letmein"];

/** Why a password is refused; each has its own words in the API and the web catalogue. */
export type PasswordRule =
  | "too_short"
  | "too_long"
  | "common"
  | "repeated"
  | "sequence"
  | "obvious_words";

/** The first rule a password breaks, or null when it may be used. */
export function passwordRuleBroken(password: string): PasswordRule | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "common";
  if (/^(.)\1+$/.test(password)) return "repeated";
  if (/^(0123456789|1234567890|abcdefghijkl)/.test(lower)) return "sequence";
  const stripped = CONTEXT_WORDS.reduce((s, w) => s.replaceAll(w, ""), lower).replace(
    /[^a-z]/g,
    "",
  );
  if (stripped.length < 4) return "obvious_words";
  return null;
}
