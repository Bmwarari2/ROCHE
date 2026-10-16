import { type PasswordRule, passwordRuleBroken } from "@harbour/domain";

/**
 * NCSC password guidance (section 5.3). The rules live in @harbour/domain (`passwordRuleBroken`)
 * so the web checks the same ones before sending; the words here match the web catalogue's
 * `invitation.password.rule.*` entries.
 */
const WORDS: Record<PasswordRule, string> = {
  too_short: "Use at least 12 characters.",
  too_long: "Use 128 characters or fewer.",
  common: "That password is too common. Try three random words.",
  repeated: "Avoid repeating one character.",
  sequence: "Avoid simple sequences.",
  obvious_words: "Avoid passwords built from obvious words. Try three random words.",
};

export function passwordProblem(password: string): string | null {
  const rule = passwordRuleBroken(password);
  return rule ? WORDS[rule] : null;
}
