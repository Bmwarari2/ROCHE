import { z } from "zod";

/**
 * Invitations (PLAT-004; platform.md, Invitations and MFA enrolment). The link's token travels only
 * in the URL fragment and in these request bodies, never in a path, a query string or a response;
 * responses carry states and times, never a token, a hash or an unmasked address.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

/** A link's token: 32 random bytes, base64url without padding (43 characters). */
export const InvitationToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .meta({ id: "InvitationToken", description: "The token from the link's fragment" });

export const SendInvitation = z
  .object({ tenantUserId: uuid })
  .meta({ id: "SendInvitation", description: "Invite a member of staff who is still invited" });
export type SendInvitation = z.infer<typeof SendInvitation>;

export const InvitationSent = z
  .object({
    id: uuid,
    expiresAt: isoDateTime,
    /** False when the email could not be handed to the organisation's email service. */
    emailSent: z.boolean(),
  })
  .meta({ id: "InvitationSent" });
export type InvitationSent = z.infer<typeof InvitationSent>;

export const InvitationState = z
  .enum(["pending", "accepted", "revoked", "expired"])
  .meta({ id: "InvitationState" });

export const InvitationSummary = z
  .object({
    id: uuid,
    state: InvitationState,
    createdAt: isoDateTime,
    expiresAt: isoDateTime,
    acceptedAt: isoDateTime.nullable(),
    revokedAt: isoDateTime.nullable(),
    revocationReason: z
      .enum(["superseded", "revoked", "member_removed", "member_changed", "expired"])
      .nullable(),
    /** Sent by Thapsus for the organisation's first owner, not by a member. */
    sentByOperator: z.boolean(),
  })
  .meta({ id: "InvitationSummary" });
export type InvitationSummary = z.infer<typeof InvitationSummary>;

export const InvitationList = z
  .object({ items: z.array(InvitationSummary) })
  .meta({ id: "InvitationList" });
export type InvitationList = z.infer<typeof InvitationList>;

export const InvitationTokenRequest = z
  .object({ token: InvitationToken })
  .meta({ id: "InvitationTokenRequest" });
export type InvitationTokenRequest = z.infer<typeof InvitationTokenRequest>;

/** Why an invitation cannot be accepted (`acceptRefusal` in packages/domain). */
export const InvitationRefusal = z
  .enum([
    "invitation_expired",
    "invitation_used",
    "invitation_revoked",
    "organisation_not_active",
    "member_not_invited",
    "email_mismatch",
    "already_member",
  ])
  .meta({ id: "InvitationRefusal" });

export const InvitationLookup = z
  .object({
    organisationName: z.string(),
    /** The first character and the domain only, while the invitation is open. */
    emailMasked: z.string().nullable(),
    expiresAt: isoDateTime,
    refusal: InvitationRefusal.nullable(),
    /** Create a sign-in, sign in first, or accept with the current sign-in (`acceptancePath`). */
    path: z.enum(["create_sign_in", "sign_in_first", "link_signed_in"]),
  })
  .meta({ id: "InvitationLookup" });
export type InvitationLookup = z.infer<typeof InvitationLookup>;

export const AcceptInvitation = z
  .object({
    token: InvitationToken,
    /** Only when creating a sign-in: NCSC rules (12 to 128 characters, deny-list). */
    password: z.string().min(1).max(128).optional(),
    /** Only when creating a sign-in: the name the sign-in shows. */
    name: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: "AcceptInvitation" });
export type AcceptInvitation = z.infer<typeof AcceptInvitation>;

export const InvitationAccepted = z
  .object({
    tenantId: uuid,
    /** `sign_in`: a sign-in was created, so sign in with it; then enrol a second factor. */
    next: z.enum(["sign_in", "enrol"]),
  })
  .meta({ id: "InvitationAccepted" });
export type InvitationAccepted = z.infer<typeof InvitationAccepted>;
