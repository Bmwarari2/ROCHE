/**
 * NCSC password guidance (section 5.3): length over complexity, a deny-list of common and
 * context-specific passwords, no forced expiry. The list is deliberately small and local: no
 * password material ever leaves the service.
 */

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

export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "That password is too common. Try three random words.";
  if (/^(.)\1+$/.test(password)) return "Avoid repeating one character.";
  if (/^(0123456789|1234567890|abcdefghijkl)/.test(lower)) return "Avoid simple sequences.";
  const stripped = CONTEXT_WORDS.reduce((s, w) => s.replaceAll(w, ""), lower).replace(
    /[^a-z]/g,
    "",
  );
  if (stripped.length < 4)
    return "Avoid passwords built from obvious words. Try three random words.";
  return null;
}
