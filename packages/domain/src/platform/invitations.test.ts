import { describe, expect, it } from "vitest";
import {
  acceptancePath,
  acceptRefusal,
  emailProblem,
  type InvitationView,
  invitationExpiresAt,
  invitationState,
  invitationsToRevoke,
  invitationsToSweep,
  inviteRefusal,
  type MemberRole,
  permissionsBeyondInviter,
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

  it("lapses after the organisation's hours, never past the Harbour maximum", () => {
    expect(invitationExpiresAt(CREATED, 72, 168)).toEqual(EXPIRES);
    expect(invitationExpiresAt(CREATED, 2000, 72)).toEqual(EXPIRES);
    for (const hours of [0, -1, Number.NaN]) {
      expect(() => invitationExpiresAt(CREATED, hours, 168)).toThrow(RangeError);
      expect(() => invitationExpiresAt(CREATED, 72, hours)).toThrow(RangeError);
    }
  });

  it("revokes every open invitation, lapsed ones too, when a new one is sent", () => {
    const used = { ...pending, acceptedAt: CREATED };
    const revoked = { ...pending, revokedAt: CREATED };
    const lapsed = { ...pending, expiresAt: CREATED };
    expect(
      invitationsToRevoke([pending, used, revoked, lapsed], at("2026-10-14T00:00:00Z")),
    ).toEqual([pending, lapsed]);
  });

  it("sweeps lapsed invitations nightly so their address is cleared (#43 review M4)", () => {
    const lapsed = { ...pending, expiresAt: CREATED };
    const used = { ...pending, acceptedAt: CREATED, expiresAt: CREATED };
    expect(invitationsToSweep([pending, lapsed, used], at("2026-10-14T00:00:00Z"))).toEqual([
      lapsed,
    ]);
  });
});

// #43 review M3: an invitation gives the member their roles' permissions, so the inviter must
// hold each of them where the role applies.
describe("an inviter covers the member's roles", () => {
  const NORTH = "north";
  const SOUTH = "south";
  // A Registered Manager at North: people and care plans there, user management there.
  const northManager = (permission: string, location: string | null) =>
    location === NORTH &&
    ["people.person.read", "care.plan.write", "platform.user.manage"].includes(permission);
  const owner = () => true;
  const carerAt = (location: string | null): MemberRole => ({
    permissions: ["people.person.read"],
    locationId: location,
  });
  const managerAt = (location: string | null): MemberRole => ({
    permissions: ["people.person.read", "care.plan.write", "platform.user.manage"],
    locationId: location,
  });
  it.each([
    ["a carer at the manager's home", [carerAt(NORTH)], northManager, []],
    ["another manager at the manager's home", [managerAt(NORTH)], northManager, []],
    ["a carer at another home", [carerAt(SOUTH)], northManager, ["people.person.read"]],
    [
      "a role across the organisation",
      [managerAt(null)],
      northManager,
      ["care.plan.write", "people.person.read", "platform.user.manage"],
    ],
    [
      "a role carrying a permission the inviter lacks",
      [{ permissions: ["people.person.read", "finance.money.approve"], locationId: NORTH }],
      northManager,
      ["finance.money.approve"],
    ],
    ["anyone, by an owner who holds everything", [managerAt(null), carerAt(SOUTH)], owner, []],
    ["a member with no roles", [], northManager, []],
  ] as const)("%s", (_name, roles, holds, missing) => {
    expect(permissionsBeyondInviter(roles, holds)).toEqual(missing);
  });
});

describe("who may be invited", () => {
  const member = {
    status: "invited",
    authUserId: null,
    email: "ada@example.invalid",
    mfaRequired: true,
  } as const;
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
    [
      "a member set up without a second factor",
      { ...member, mfaRequired: false },
      "member_mfa_not_required",
    ],
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
    organisationActive: true,
    memberStatus: "invited",
    invitedEmail: "ada@example.invalid",
    signedInEmail: null,
    signedInAlreadyMember: false,
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
    [
      "an organisation suspended or closed",
      { ...base, organisationActive: false },
      "organisation_not_active",
    ],
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
