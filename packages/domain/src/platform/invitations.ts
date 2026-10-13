/**
 * Invitations and enrolment (PLAT-004; platform.md, Invitations and MFA enrolment). A holder of
 * `platform.user.manage` invites a member of staff by email, only where it holds every permission
 * of the member's roles; the link is single use, lapses after `invitation.expiry_hours` (capped by
 * `invitation.expiry_hours_max`, rate table), carries its token in the URL fragment and is kept only
 * as a hash. The invitee sets a password meeting the NCSC rules and then enrols a passkey or an
 * authenticator app before any care record opens (`mfa_enrolment_required`); SMS is never offered
 * as a second factor. The address is cleared once the invitation is accepted, revoked or lapsed.
 */

import { isPlausibleEmail, normaliseEmail } from "../shared/email";

export const INVITATION_RATE_KEYS = {
  expiryHours: "invitation.expiry_hours",
  expiryHoursMax: "invitation.expiry_hours_max",
} as const;

/** Bytes of randomness in an invitation link's token (256 bits); only its SHA-256 is stored. */
export const INVITATION_TOKEN_BYTES = 32;

export type MemberStatus = "invited" | "active" | "suspended" | "left";

/**
 * Why an invitation was revoked: a newer one replaced it, a manager withdrew it, the member was
 * suspended or removed, the member's address or roles changed, or it lapsed (the nightly sweep).
 */
export const INVITATION_REVOCATION_REASONS = [
  "superseded",
  "revoked",
  "member_removed",
  "member_changed",
  "expired",
] as const;
export type InvitationRevocationReason = (typeof INVITATION_REVOCATION_REASONS)[number];

export interface InvitationView {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type InvitationState = "pending" | "accepted" | "revoked" | "expired";

/** Accepted and revoked are final; otherwise the link lapses at `expiresAt` (exclusive). */
export function invitationState(invitation: InvitationView, now: Date): InvitationState {
  if (invitation.acceptedAt !== null) return "accepted";
  if (invitation.revokedAt !== null) return "revoked";
  return now.getTime() >= invitation.expiresAt.getTime() ? "expired" : "pending";
}

/** When a new link lapses: the organisation's hours, never past the Harbour maximum. */
export function invitationExpiresAt(createdAt: Date, expiryHours: number, maxHours: number): Date {
  for (const [name, value] of [
    [INVITATION_RATE_KEYS.expiryHours, expiryHours],
    [INVITATION_RATE_KEYS.expiryHoursMax, maxHours],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive number of hours`);
    }
  }
  return new Date(createdAt.getTime() + Math.min(expiryHours, maxHours) * 3_600_000);
}

/**
 * A plain-English problem with an address an invitation would be sent to, or null (the shared
 * check: printable ASCII shaped like local@domain.tld, no regular expression to backtrack).
 */
export function emailProblem(email: string): string | null {
  if (email.trim().length === 0) return "Enter an email address.";
  return isPlausibleEmail(email) ? null : "Enter an email address like name@example.com.";
}

export type InviteRefusal =
  | "member_active"
  | "member_suspended"
  | "member_left"
  | "member_has_sign_in"
  | "member_mfa_not_required"
  | "email_invalid";

/**
 * Why a member may not be sent an invitation now, or null. Only a member still `invited`, not yet
 * linked to a sign-in and required to use a second factor is invited (a member set up without
 * MFA is never invited); sending a new invitation revokes any open one (`invitationsToRevoke`),
 * so only the latest link works.
 */
export function inviteRefusal(member: {
  readonly status: MemberStatus;
  readonly authUserId: string | null;
  readonly email: string;
  readonly mfaRequired: boolean;
}): InviteRefusal | null {
  if (member.status === "active") return "member_active";
  if (member.status === "suspended") return "member_suspended";
  if (member.status === "left") return "member_left";
  if (member.authUserId !== null) return "member_has_sign_in";
  if (!member.mfaRequired) return "member_mfa_not_required";
  if (emailProblem(member.email) !== null) return "email_invalid";
  return null;
}

/** A role the member holds: its permissions and where (null: across the organisation). */
export interface MemberRole {
  readonly permissions: readonly string[];
  readonly locationId: string | null;
}

/**
 * The permissions of the member's roles the inviter does not hold where each role applies (#43
 * review M3): an invitation gives the member those permissions, so an inviter may only invite a
 * member whose every role sits within its own permissions there. `inviterHoldsAt(permission,
 * location)` answers for a location, or for the whole organisation when the location is null.
 * Empty when the inviter covers the member.
 */
export function permissionsBeyondInviter(
  memberRoles: readonly MemberRole[],
  inviterHoldsAt: (permission: string, locationId: string | null) => boolean,
): string[] {
  const missing = new Set<string>();
  for (const role of memberRoles) {
    for (const permission of role.permissions) {
      if (!inviterHoldsAt(permission, role.locationId)) missing.add(permission);
    }
  }
  return [...missing].sort();
}

/** The member's open invitations (pending or lapsed but not yet swept), which a new one revokes. */
export function invitationsToRevoke<T extends InvitationView>(
  invitations: readonly T[],
  now: Date,
): T[] {
  return invitations.filter((i) => {
    const state = invitationState(i, now);
    return state === "pending" || state === "expired";
  });
}

/** The invitations the nightly sweep revokes as `expired`, clearing their address (#43 review M4). */
export function invitationsToSweep<T extends InvitationView>(
  invitations: readonly T[],
  now: Date,
): T[] {
  return invitations.filter((i) => invitationState(i, now) === "expired");
}

export type AcceptRefusal =
  | "invitation_expired"
  | "invitation_used"
  | "invitation_revoked"
  | "organisation_not_active"
  | "member_not_invited"
  | "email_mismatch"
  | "already_member";

/**
 * Why an invitation link may not be accepted now, or null. The organisation must be onboarding or
 * active, and the member still `invited` (a member suspended or removed since loses the link). A
 * person accepting while signed in (one sign-in for several organisations, such as an agency
 * worker) must be signed in with the address the invitation was sent to, and not already be
 * another member of the same organisation.
 */
export function acceptRefusal(input: {
  readonly invitation: InvitationView;
  readonly organisationActive: boolean;
  readonly memberStatus: MemberStatus;
  readonly invitedEmail: string;
  readonly signedInEmail: string | null;
  /** The signed-in person already belongs to the organisation as another member. */
  readonly signedInAlreadyMember: boolean;
  readonly now: Date;
}): AcceptRefusal | null {
  const state = invitationState(input.invitation, input.now);
  if (state === "accepted") return "invitation_used";
  if (state === "revoked") return "invitation_revoked";
  if (state === "expired") return "invitation_expired";
  if (!input.organisationActive) return "organisation_not_active";
  if (input.memberStatus !== "invited") return "member_not_invited";
  if (
    input.signedInEmail !== null &&
    normaliseEmail(input.signedInEmail) !== normaliseEmail(input.invitedEmail)
  ) {
    return "email_mismatch";
  }
  if (input.signedInAlreadyMember) return "already_member";
  return null;
}

export type AcceptancePath = "create_sign_in" | "link_signed_in" | "sign_in_first";

/**
 * How an accepted invitation reaches a sign-in. A new sign-in (email and password) is created
 * only when none exists for the address; an existing sign-in is linked only when the person is
 * signed in with it, never by setting a password through the link, so an invitation can never
 * take over an existing account.
 */
export function acceptancePath(input: {
  readonly signInExistsForEmail: boolean;
  readonly signedIn: boolean;
}): AcceptancePath {
  if (input.signedIn) return "link_signed_in";
  return input.signInExistsForEmail ? "sign_in_first" : "create_sign_in";
}
