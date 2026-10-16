import { type PasswordRule, passwordRuleBroken } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  asRefusal,
  destinationAfterAccept,
  ENROLMENT_PATH,
  type InvitationRefusal,
  isFinal,
  isInvitationToken,
  isSameOrigin,
  KEPT_TOKEN_MINUTES,
  keptToken,
  offersSignIn,
  readKeptToken,
  retryMinutes,
  SIGN_IN_THEN_RETURN,
  tokenFromFragment,
} from "./invitations";
import { safeNextPath } from "./problems";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6";

describe("tokenFromFragment", () => {
  it.each([
    [`#${TOKEN}`, TOKEN],
    [TOKEN, TOKEN],
    ["", null],
    ["#", null],
    [`#${TOKEN}x`, null],
    [`#${TOKEN.slice(1)}`, null],
    [`#${TOKEN.slice(1)}=`, null],
    [`#${TOKEN.slice(1)}/`, null],
    ["#token=abc", null],
  ])("%s", (hash, expected) => {
    expect(tokenFromFragment(hash)).toBe(expected);
  });

  it("only accepts strings", () => {
    expect(isInvitationToken(undefined)).toBe(false);
    expect(isInvitationToken(42)).toBe(false);
  });
});

describe("asRefusal", () => {
  it.each([
    ["invitation_expired", "invitation_expired"],
    ["invitation_revoked", "invitation_revoked"],
    ["invitation_used", "invitation_used"],
    ["email_mismatch", "email_mismatch"],
    ["member_active", "invitation_closed"],
    ["something_new", "invitation_closed"],
    [undefined, "invitation_closed"],
  ])("%s reads as %s", (code, expected) => {
    expect(asRefusal(code)).toBe(expected);
  });
});

describe("refusal handling", () => {
  it("keeps the token only where the link can still work", () => {
    expect(isFinal("email_mismatch")).toBe(false);
    expect(isFinal("no_token")).toBe(false);
    expect(isFinal("invitation_expired")).toBe(true);
    expect(isFinal("not_found")).toBe(true);
  });

  it("offers sign-in when the link is spent or the person already belongs", () => {
    expect(offersSignIn("invitation_used")).toBe(true);
    expect(offersSignIn("already_member")).toBe(true);
    expect(offersSignIn("invitation_revoked")).toBe(false);
  });

  it.each<[InvitationRefusal, string]>([
    ["invitation_expired", "This invitation has expired. Ask your manager to send you a new one."],
    [
      "invitation_revoked",
      "This invitation was withdrawn. Ask your manager if you still need to join.",
    ],
    ["invitation_used", "This invitation has already been used. If it was you, sign in."],
    [
      "invitation_closed",
      "This invitation has already been accepted or withdrawn. Sign in, or ask your manager for a new one.",
    ],
    ["no_token", "This link is not complete. Open the link from your email again."],
  ])("%s is said in plain words", (refusal, words) => {
    expect(t("invitation.refusal", { refusal })).toBe(words);
  });
});

describe("retryMinutes", () => {
  it.each([
    ["30", 1],
    ["60", 1],
    ["61", 2],
    ["900", 15],
    ["0", 1],
    ["soon", 1],
    [null, 1],
  ])("Retry-After %s is %i minutes", (header, minutes) => {
    expect(retryMinutes(header)).toBe(minutes);
  });

  it("is said in plain words", () => {
    expect(t("invitation.throttled.body", { minutes: 1 })).toBe("Wait 1 minute, then try again.");
    expect(t("invitation.throttled.body", { minutes: 15 })).toBe(
      "Wait 15 minutes, then try again.",
    );
  });
});

describe("after accepting", () => {
  it("sends a new sign-in to sign in, then to enrolment", () => {
    const target = new URL(destinationAfterAccept("sign_in"), "https://harbour.example.invalid");
    expect(target.pathname).toBe("/sign-in");
    expect(safeNextPath(target.searchParams.get("next"))).toBe(ENROLMENT_PATH);
  });

  it("sends an existing sign-in to enrolment too", () => {
    expect(destinationAfterAccept("enrol")).toBe(ENROLMENT_PATH);
  });

  it("comes back to the page after signing in first, without the token in the URL", () => {
    const target = new URL(SIGN_IN_THEN_RETURN, "https://harbour.example.invalid");
    expect(target.searchParams.get("next")).toBe("/invitation");
    expect(target.hash).toBe("");
  });
});

describe("password rules", () => {
  // The API's words (apps/api/src/auth/password-policy.ts), so both say the same thing.
  it.each<[string, PasswordRule, string]>([
    ["short", "too_short", "Use at least 12 characters."],
    ["x".repeat(129), "too_long", "Use 128 characters or fewer."],
    ["Password1234", "common", "That password is too common. Try three random words."],
    ["aaaaaaaaaaaaaa", "repeated", "Avoid repeating one character."],
    ["1234567890123", "sequence", "Avoid simple sequences."],
    [
      "harbour2026!!",
      "obvious_words",
      "Avoid passwords built from obvious words. Try three random words.",
    ],
  ])("%s", (password, rule, words) => {
    expect(passwordRuleBroken(password)).toBe(rule);
    expect(t("invitation.password.rule", { rule })).toBe(words);
  });

  it("shows the rules before anyone types, with no composition rules", () => {
    const hint = t("invitation.password.hint");
    expect(hint).toContain("at least 12 characters");
    expect(hint).toContain("You do not need numbers, symbols or capital letters");
  });
});

describe("the kept token", () => {
  const at = new Date("2026-10-16T10:00:00Z");
  const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000);

  it("lasts 30 minutes in this tab", () => {
    const stored = keptToken(TOKEN, at);
    expect(readKeptToken(stored, at)).toBe(TOKEN);
    expect(readKeptToken(stored, later(KEPT_TOKEN_MINUTES))).toBe(TOKEN);
    expect(readKeptToken(stored, later(KEPT_TOKEN_MINUTES + 1))).toBeNull();
    expect(readKeptToken(stored, later(-1))).toBeNull();
  });

  it.each([null, "", "not json", TOKEN, JSON.stringify({ token: "short", at: at.getTime() })])(
    "ignores %s",
    (stored) => {
      expect(readKeptToken(stored, at)).toBeNull();
    },
  );
});

describe("isSameOrigin", () => {
  it.each([
    ["https://app.example.invalid", "app.example.invalid", true],
    ["http://localhost:3000", "localhost:3000", true],
    ["https://app.example.invalid", "app.example.invalid, internal:3000", true],
    ["https://evil.example.invalid", "app.example.invalid", false],
    ["http://localhost:3001", "localhost:3000", false],
    [null, "app.example.invalid", false],
    ["null", "app.example.invalid", false],
    ["https://app.example.invalid", null, false],
  ])("%s for %s is %s", (origin, host, expected) => {
    expect(isSameOrigin(origin, host)).toBe(expected);
  });
});
