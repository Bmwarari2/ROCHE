/**
 * Invitations and enrolment (PLAT-004; platform.md, Invitations and MFA enrolment). A holder of
 * `platform.user.manage` invites a member of staff by email; the link is single-use, lapses after
 * `invitation.expiry_hours` (rate table) and is kept only as a hash. The invitee sets a password
 * meeting the NCSC rules and then enrols a passkey or an authenticator app before any care record
 * opens (`mfa_enrolment_required`); SMS is never offered as a second factor. These are the rules;
 * the store waits for migration 0054 (Lane A).
 */

import { isPlausibleEmail, normaliseEmail } from "../shared/email";

export const INVITATION_RATE_KEYS = { expiryHours: "invitation.expiry_hours" } as const;

/** Bytes of randomness in an invitation link's token (256 bits); only its SHA-256 is stored. */
export const INVITATION_TOKEN_BYTES = 32;

export type MemberStatus = "invited" | "active" | "suspended" | "left";

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

export function invitationExpiresAt(createdAt: Date, expiryHours: number): Date {
  if (!Number.isFinite(expiryHours) || expiryHours <= 0) {
    throw new RangeError("invitation.expiry_hours must be a positive number of hours");
  }
  return new Date(createdAt.getTime() + expiryHours * 3_600_000);
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
  | "email_invalid";

/**
 * Why a member may not be sent an invitation now, or null. Only a member still `invited` and not
 * yet linked to a sign-in is invited; sending a new invitation revokes any pending one
 * (`invitationsToRevoke`), so only the latest link works.
 */
export function inviteRefusal(member: {
  readonly status: MemberStatus;
  readonly authUserId: string | null;
  readonly email: string;
}): InviteRefusal | null {
  if (member.status === "active") return "member_active";
  if (member.status === "suspended") return "member_suspended";
  if (member.status === "left") return "member_left";
  if (member.authUserId !== null) return "member_has_sign_in";
  if (emailProblem(member.email) !== null) return "email_invalid";
  return null;
}

/** The member's invitations still pending, which a new invitation revokes. */
export function invitationsToRevoke<T extends InvitationView>(
  invitations: readonly T[],
  now: Date,
): T[] {
  return invitations.filter((i) => invitationState(i, now) === "pending");
}

export type AcceptRefusal =
  | "invitation_expired"
  | "invitation_used"
  | "invitation_revoked"
  | "member_not_invited"
  | "email_mismatch"
  | "already_member";

/**
 * Why an invitation link may not be accepted now, or null. The member must still be `invited`
 * (a member suspended or removed since loses the link). A person accepting while signed in (one
 * sign-in for several organisations, such as an agency worker) must be signed in with the address
 * the invitation was sent to, and not already be another member of the same organisation.
 */
export function acceptRefusal(input: {
  readonly invitation: InvitationView;
  readonly memberStatus: MemberStatus;
  readonly invitedEmail: string;
  readonly signedInEmail: string | null;
  /** The signed-in person already belongs to the organisation as another member. */
  readonly signedInAlreadyMember?: boolean;
  readonly now: Date;
}): AcceptRefusal | null {
  const state = invitationState(input.invitation, input.now);
  if (state === "accepted") return "invitation_used";
  if (state === "revoked") return "invitation_revoked";
  if (state === "expired") return "invitation_expired";
  if (input.memberStatus !== "invited") return "member_not_invited";
  if (
    input.signedInEmail !== null &&
    normaliseEmail(input.signedInEmail) !== normaliseEmail(input.invitedEmail)
  ) {
    return "email_mismatch";
  }
  if (input.signedInAlreadyMember === true) return "already_member";
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
