import { describe, expect, it } from "vitest";
import {
  acceptancePath,
  acceptRefusal,
  emailProblem,
  type InvitationView,
  invitationExpiresAt,
  invitationState,
  invitationsToRevoke,
  inviteRefusal,
} from "./invitations";

const CREATED = new Date("2026-10-13T09:00:00Z");
const EXPIRES = new Date("2026-10-16T09:00:00Z");
const pending: InvitationView = {
  createdAt: CREATED,
  expiresAt: EXPIRES,
  acceptedAt: null,
  revokedAt: null,
};
const at = (iso: string) => new Date(iso);

describe("invitation state (PLAT-004)", () => {
  it.each([
    ["pending before it lapses", pending, at("2026-10-16T08:59:59Z"), "pending"],
    ["expired at its expiry", pending, EXPIRES, "expired"],
    [
      "accepted stays accepted after expiry",
      { ...pending, acceptedAt: CREATED },
      at("2026-11-01T00:00:00Z"),
      "accepted",
    ],
    ["revoked stays revoked", { ...pending, revokedAt: CREATED }, CREATED, "revoked"],
    [
      "accepted wins over a later revocation",
      { ...pending, acceptedAt: CREATED, revokedAt: EXPIRES },
      CREATED,
      "accepted",
    ],
  ] as const)("%s", (_name, invitation, now, state) => {
    expect(invitationState(invitation, now)).toBe(state);
  });

  it("lapses after the rate table's hours", () => {
    expect(invitationExpiresAt(CREATED, 72)).toEqual(EXPIRES);
    for (const hours of [0, -1, Number.NaN]) {
      expect(() => invitationExpiresAt(CREATED, hours)).toThrow(RangeError);
    }
  });

  it("revokes every pending invitation when a new one is sent", () => {
    const used = { ...pending, acceptedAt: CREATED };
    const lapsed = { ...pending, expiresAt: CREATED };
    expect(invitationsToRevoke([pending, used, lapsed], at("2026-10-14T00:00:00Z"))).toEqual([
      pending,
    ]);
  });
});

describe("who may be invited", () => {
  const member = { status: "invited", authUserId: null, email: "ada@example.invalid" } as const;
  it.each([
    ["an invited member with no sign-in", member, null],
    ["an active member", { ...member, status: "active" }, "member_active"],
    ["a suspended member", { ...member, status: "suspended" }, "member_suspended"],
    ["a member who has left", { ...member, status: "left" }, "member_left"],
    [
      "a member already linked to a sign-in",
      { ...member, authUserId: "auth-1" },
      "member_has_sign_in",
    ],
    ["a member with an unusable address", { ...member, email: "not an address" }, "email_invalid"],
  ] as const)("%s", (_name, input, refusal) => {
    expect(inviteRefusal(input)).toBe(refusal);
  });

  it.each([
    ["ada@example.invalid", null],
    ["  Ada@Example.Invalid ", null],
    ["", "Enter an email address."],
    ["ada@example", "Enter an email address like name@example.com."],
    ["ada example@example.invalid", "Enter an email address like name@example.com."],
    [`${"a".repeat(250)}@example.invalid`, "Enter an email address like name@example.com."],
    ["аda@example.invalid", "Enter an email address like name@example.com."],
  ])("checks the address %s", (email, problem) => {
    expect(emailProblem(email)).toBe(problem);
  });
});

describe("accepting an invitation", () => {
  const base = {
    invitation: pending,
    memberStatus: "invited",
    invitedEmail: "ada@example.invalid",
    signedInEmail: null,
    now: at("2026-10-14T00:00:00Z"),
  } as const;
  it.each([
    ["a pending invitation", base, null],
    [
      "a link already used (single use)",
      { ...base, invitation: { ...pending, acceptedAt: CREATED } },
      "invitation_used",
    ],
    [
      "a revoked link",
      { ...base, invitation: { ...pending, revokedAt: CREATED } },
      "invitation_revoked",
    ],
    ["an expired link", { ...base, now: EXPIRES }, "invitation_expired"],
    ["a member suspended since", { ...base, memberStatus: "suspended" }, "member_not_invited"],
    ["a member removed since", { ...base, memberStatus: "left" }, "member_not_invited"],
    ["signed in with the invited address", { ...base, signedInEmail: "ADA@example.invalid" }, null],
    [
      "signed in with another address",
      { ...base, signedInEmail: "bea@example.invalid" },
      "email_mismatch",
    ],
    [
      "signed in as another member of the organisation",
      { ...base, signedInEmail: "ada@example.invalid", signedInAlreadyMember: true },
      "already_member",
    ],
  ] as const)("%s", (_name, input, refusal) => {
    expect(acceptRefusal(input)).toBe(refusal);
  });

  it.each([
    [
      "no sign-in for the address: a new one is made",
      { signInExistsForEmail: false, signedIn: false },
      "create_sign_in",
    ],
    [
      "a sign-in exists: never set its password through the link",
      { signInExistsForEmail: true, signedIn: false },
      "sign_in_first",
    ],
    [
      "signed in: link that sign-in",
      { signInExistsForEmail: true, signedIn: true },
      "link_signed_in",
    ],
  ] as const)("%s", (_name, input, path) => {
    expect(acceptancePath(input)).toBe(path);
  });
});
