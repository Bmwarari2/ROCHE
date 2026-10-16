import {
  AcceptInvitation,
  InvitationAccepted,
  InvitationList,
  InvitationLookup,
  InvitationSent,
  InvitationTokenRequest,
  SendInvitation,
} from "@harbour/contracts";
import { invitation, type Transaction, tenantUser } from "@harbour/db";
import {
  acceptancePath,
  INVITATION_RATE_KEYS,
  type InvitationRevocationReason,
  invitationExpiresAt,
  invitationState,
  inviteRefusal,
  type MemberStatus,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { passwordProblem } from "../auth/password-policy";
import { auditInTx, writeAudit } from "../http/audit";
import { type AppEnv, clientIp, requirePermission, type TenantAccess } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { throttleAddress } from "../http/throttle";
import { inSystemView } from "../services/devices";
import {
  acceptInvitation,
  audit,
  findInvitation,
  invitationTokenHash,
  newInvitationToken,
  recordSignIn,
  removeSignIn,
  sendInvitationEmail,
} from "../services/invitations";
import { memberReached } from "./member-sessions";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  limitedResponse,
  notFoundResponse,
  security,
} from "./openapi";
import { requireStepUp } from "./people-shared";

/**
 * Invitation routes (PLAT-004; platform.md, Invitations and MFA enrolment). Sending, listing and
 * revoking need `platform.user.manage` and reach only the members it reaches (`memberReached`, as
 * the admin sign-out does): a location role only members wholly at its homes, never the owner or
 * another home's staff, although `invitation_scope` lets it read every invitation (#48 review).
 * Opening and accepting a link need no session; both are throttled per client address and per
 * token. The token arrives only in a request body and goes to the database only as a bound
 * parameter; it is never logged, audited or returned.
 */

const PERMISSION = "platform.user.manage";
const SENT = "platform.invitation.sent";
const REVOKED = "platform.invitation.revoked";

const refusalProblem = (code: string) =>
  new HttpProblem(409, code, "This invitation cannot be used.", REFUSAL_DETAIL[code]);

const REFUSAL_DETAIL: Record<string, string> = {
  invitation_expired: "The link has expired. Ask your manager to send a new invitation.",
  invitation_used: "The link has already been used. Sign in instead.",
  invitation_revoked: "The link was withdrawn. Ask your manager to send a new invitation.",
  organisation_not_active: "The organisation is not using Harbour at the moment.",
  member_not_invited: "Your place in the organisation has changed. Ask your manager.",
  email_mismatch:
    "You are signed in with a different email address. Sign out and open the link again.",
  already_member: "You already belong to this organisation. Sign in instead.",
  sign_in_first:
    "There is already a sign-in for this email address. Sign in, then open the link again.",
  invitation_closed: "The invitation has already been accepted or withdrawn.",
  member_active: "This person has already joined.",
  member_suspended: "This person is suspended.",
  member_left: "This person has left.",
  member_has_sign_in: "This person already has a sign-in.",
  member_mfa_not_required:
    "This person is not required to use a second factor, so cannot be invited.",
  email_invalid: "This person's email address is not valid. Correct it, then invite them.",
};

/** The member a manager names, if it exists and their permission reaches it; null otherwise. */
async function reachedMember(tx: Transaction, access: TenantAccess, memberId: string) {
  const [member] = await tx
    .select({
      status: tenantUser.status,
      authUserId: tenantUser.authUserId,
      email: tenantUser.email,
      mfaRequired: tenantUser.mfaRequired,
    })
    .from(tenantUser)
    .where(and(eq(tenantUser.id, memberId), isNull(tenantUser.deletedAt)));
  if (!member || !(await memberReached(tx, access, memberId, new Date()))) return null;
  return member;
}

/** Throttles a link request per client address, then per token (counted by its hash). */
function throttle(c: Context<AppEnv>, token: string): void {
  const services = c.get("services");
  const { address, token: perToken } = services.invitationThrottles;
  const from = throttleAddress(c.req.header("x-forwarded-for"), services.config.trustedProxies);
  // No address: per token only, never one bucket every such client shares (#53 review L2).
  const wait =
    (from === null ? null : address.take(from)) ?? perToken.take(invitationTokenHash(token));
  if (wait === null) return;
  const problem = new HttpProblem(
    429,
    "rate_limited",
    "Too many attempts. Wait a moment and try again.",
  );
  problem.retryAfterSeconds = wait;
  throw problem;
}

/** An unknown token: 404, and a platform audit event (no organisation is known). */
async function unknownToken(c: Context<AppEnv>, action: string): Promise<HttpProblem> {
  await audit(c.get("services").appPool, null, {
    action,
    outcome: "denied",
    reason: "unknown_token",
    ip: clientIp(c),
    requestId: c.get("requestId"),
    ...(c.get("session") ? { actorAuthUserId: c.get("session")?.authUserId } : {}),
  });
  return problems.notFound();
}

const IdParam = z.object({ id: z.uuid() });

type SendOutcome =
  | { readonly refused: string }
  | { readonly sent: { id: string; email: string; expiresAt: Date } };

export const invitationsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/invitations",
      tags: ["platform"],
      summary: "Invite a member of staff",
      description:
        "Sends a single-use link to a member who is still invited, has no sign-in and must use a second factor (platform.user.manage, step-up), only within the member's reach and where the sender holds every permission of the member's roles (app.may_invite). Revokes the member's open invitation (superseded). The address is the member's own; the link is emailed and never returned. Audited, refusals too.",
      security,
      request: { body: { content: { "application/json": { schema: SendInvitation } } } },
      responses: {
        201: jsonBody(InvitationSent, "Sent"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, SENT);
      const { tenantUserId } = c.req.valid("json");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const refuse = async (reason: string, problem: HttpProblem) => {
        await writeAudit(services.appPool, access, {
          action: SENT,
          outcome: "denied",
          resourceType: "tenant_user",
          resourceId: tenantUserId,
          reason,
          requestId,
        });
        return problem;
      };
      const { token, hash } = newInvitationToken();
      const outcome = await inSystemView(services.db, access, async (tx): Promise<SendOutcome> => {
        const member = await reachedMember(tx, access, tenantUserId);
        if (!member) return { refused: "not_found_or_out_of_scope" };
        const refusal = inviteRefusal({ ...member, status: member.status as MemberStatus });
        if (refusal) return { refused: refusal };
        const may = await tx.execute<{ may: boolean }>(
          sql`SELECT app.may_invite(${tenantUserId}) AS may`,
        );
        if (may.rows[0]?.may !== true) return { refused: "beyond_inviter" };
        const rates = await tx.execute<{ hours: string | null; max: string | null }>(
          sql`SELECT app.invitation_rate(${access.tenantId}, ${INVITATION_RATE_KEYS.expiryHours}, false) AS hours,
                     app.invitation_rate(${access.tenantId}, ${INVITATION_RATE_KEYS.expiryHoursMax}, true) AS max`,
        );
        const expiresAt = invitationExpiresAt(
          new Date(),
          Number(rates.rows[0]?.hours ?? Number.NaN),
          Number(rates.rows[0]?.max ?? Number.NaN),
        );
        const superseded = await tx
          .update(invitation)
          .set({
            revokedAt: sql`clock_timestamp()`,
            revokedBy: access.tenantUserId,
            revocationReason: "superseded",
          })
          .where(
            and(
              eq(invitation.tenantUserId, tenantUserId),
              isNull(invitation.acceptedAt),
              isNull(invitation.revokedAt),
            ),
          )
          .returning({ id: invitation.id });
        for (const { id } of superseded) {
          await auditInTx(tx, access, {
            action: REVOKED,
            resourceType: "invitation",
            resourceId: id,
            reason: "superseded",
            scope: { tenantUserId },
            requestId,
          });
        }
        // Raw SQL: the application may insert only these columns (migration 0054).
        const inserted = await tx.execute<{ id: string; email: string; expires_at: Date }>(
          sql`INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by)
              VALUES (${tenantUserId}, ${hash}, ${expiresAt.toISOString()}, ${access.tenantUserId})
              RETURNING id, email, expires_at`,
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("invitation not stored");
        await auditInTx(tx, access, {
          action: SENT,
          resourceType: "invitation",
          resourceId: row.id,
          scope: { tenantUserId, expiresAt: expiresAt.toISOString() },
          requestId,
        });
        return { sent: { id: row.id, email: row.email, expiresAt: new Date(row.expires_at) } };
      });
      if ("refused" in outcome) {
        const reason = outcome.refused;
        throw await refuse(
          reason,
          reason === "not_found_or_out_of_scope"
            ? problems.notFound()
            : reason === "beyond_inviter"
              ? new HttpProblem(
                  403,
                  "beyond_inviter",
                  "You cannot invite this person.",
                  "Their roles include permissions you do not hold where those roles apply.",
                )
              : refusalProblem(reason),
        );
      }
      const emailSent = await sendInvitationEmail(
        {
          db: services.db,
          appPool: services.appPool,
          webOrigin: services.config.webOrigins[0] ?? services.config.BETTER_AUTH_URL,
          adapterFor: services.adapterFor,
        },
        { id: outcome.sent.id, tenantId: access.tenantId, email: outcome.sent.email },
        token,
        { actorAuthUserId: access.session.authUserId, requestId },
      );
      return c.json(
        { id: outcome.sent.id, expiresAt: outcome.sent.expiresAt.toISOString(), emailSent },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/invitations",
      tags: ["platform"],
      summary: "A member's invitations: states and times",
      description:
        "platform.user.manage, for a member within its reach only (anyone else reads as not found). Never a token, a hash or an address.",
      security,
      request: { query: z.object({ tenantUserId: z.uuid() }) },
      responses: {
        200: jsonBody(InvitationList, "Invitations, newest first"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { tenantUserId } = c.req.valid("query");
      const services = c.get("services");
      const rows = await inSystemView(services.db, access, async (tx) => {
        if (!(await reachedMember(tx, access, tenantUserId))) return null;
        return tx
          .select({
            id: invitation.id,
            createdAt: invitation.createdAt,
            expiresAt: invitation.expiresAt,
            acceptedAt: invitation.acceptedAt,
            revokedAt: invitation.revokedAt,
            revocationReason: invitation.revocationReason,
            createdByOperator: invitation.createdByOperator,
          })
          .from(invitation)
          .where(eq(invitation.tenantUserId, tenantUserId))
          .orderBy(desc(invitation.createdAt));
      });
      if (!rows) {
        await writeAudit(services.appPool, access, {
          action: "platform.invitation.list",
          outcome: "denied",
          resourceType: "tenant_user",
          resourceId: tenantUserId,
          reason: "not_found_or_out_of_scope",
          requestId: c.get("requestId"),
        });
        throw problems.notFound();
      }
      const now = new Date();
      const iso = (d: Date | null) => (d ? d.toISOString() : null);
      return c.json(
        {
          items: rows.map((r) => ({
            id: r.id,
            state: invitationState(r, now),
            createdAt: r.createdAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            acceptedAt: iso(r.acceptedAt),
            revokedAt: iso(r.revokedAt),
            revocationReason: r.revocationReason as InvitationRevocationReason | null,
            sentByOperator: r.createdByOperator !== null,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/invitations/{id}/revoke",
      tags: ["platform"],
      summary: "Withdraw an open invitation",
      description:
        "platform.user.manage, for a member within its reach only (anyone else reads as not found). The link stops working at once. Audited.",
      security,
      request: { params: IdParam },
      responses: {
        204: { description: "Withdrawn" },
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { id } = c.req.valid("param");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const result = await inSystemView(services.db, access, async (tx) => {
        const [found] = await tx
          .select({ tenantUserId: invitation.tenantUserId })
          .from(invitation)
          .where(eq(invitation.id, id));
        if (!found || !(await reachedMember(tx, access, found.tenantUserId))) return "not_found";
        const revoked = await tx
          .update(invitation)
          .set({
            revokedAt: sql`clock_timestamp()`,
            revokedBy: access.tenantUserId,
            revocationReason: "revoked",
          })
          .where(
            and(eq(invitation.id, id), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)),
          )
          .returning({ id: invitation.id });
        if (revoked.length === 0) return "invitation_closed";
        await auditInTx(tx, access, {
          action: REVOKED,
          resourceType: "invitation",
          resourceId: id,
          reason: "revoked",
          scope: { tenantUserId: found.tenantUserId },
          requestId,
        });
        return "revoked";
      });
      if (result !== "revoked") {
        await writeAudit(services.appPool, access, {
          action: REVOKED,
          outcome: "denied",
          resourceType: "invitation",
          resourceId: id,
          reason: result === "not_found" ? "not_found_or_out_of_scope" : result,
          requestId,
        });
        throw result === "not_found" ? problems.notFound() : refusalProblem(result);
      }
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/invitations/lookup",
      tags: ["platform"],
      summary: "What an invitation link is for (no sign-in needed)",
      description:
        "The token from the link's fragment, in the body. The organisation's name, the address masked, the expiry, why it cannot be accepted, and whether to create a sign-in or sign in first. Changes nothing. Throttled per client address and per token; an unknown token is 404 and audited.",
      request: { body: { content: { "application/json": { schema: InvitationTokenRequest } } } },
      responses: {
        200: jsonBody(InvitationLookup, "The invitation"),
        ...notFoundResponse,
        ...limitedResponse,
        422: errorResponses[422],
      },
    }),
    async (c) => {
      const { token } = c.req.valid("json");
      throttle(c, token);
      const services = c.get("services");
      const found = await findInvitation(services.appPool, token);
      if (!found) throw await unknownToken(c, "platform.invitation.lookup");
      const session = c.get("session");
      const signInExists =
        session === null && found.email !== null
          ? ((
              await services.authPool.query('SELECT 1 FROM auth."user" WHERE lower(email) = $1', [
                found.email,
              ])
            ).rowCount ?? 0) > 0
          : false;
      return c.json(
        {
          organisationName: found.organisationName,
          emailMasked: found.emailMasked,
          expiresAt: found.expiresAt.toISOString(),
          refusal:
            found.refusal ??
            (session && found.email !== null && session.email.toLowerCase() !== found.email
              ? "email_mismatch"
              : null),
          path: acceptancePath({ signInExistsForEmail: signInExists, signedIn: session !== null }),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/invitations/accept",
      tags: ["platform"],
      summary: "Accept an invitation (no sign-in needed to create one)",
      description:
        "Signed in: links that sign-in, if its address is the invitation's. Not signed in: creates a sign-in for the invited address with a password meeting the NCSC rules, only when none exists (otherwise 409 sign_in_first, so a link never sets an existing account's password); the new sign-in is recorded on the invitation before the acceptance, and deleted if the acceptance fails. Then sign in (next: sign_in) and enrol a passkey or an authenticator app. Throttled like the lookup; refusals are audited.",
      request: { body: { content: { "application/json": { schema: AcceptInvitation } } } },
      responses: {
        200: jsonBody(InvitationAccepted, "Accepted"),
        ...notFoundResponse,
        ...conflictResponse,
        ...limitedResponse,
        422: errorResponses[422],
      },
    }),
    async (c) => {
      const { token, password, name } = c.req.valid("json");
      throttle(c, token);
      const services = c.get("services");
      const requestId = c.get("requestId");
      const session = c.get("session");
      const found = await findInvitation(services.appPool, token);
      if (!found) throw await unknownToken(c, "platform.invitation.accepted");
      const refuse = async (reason: string, actorAuthUserId?: string) => {
        await audit(services.appPool, found.tenantId, {
          action: "platform.invitation.accepted",
          outcome: "denied",
          resourceId: found.invitationId,
          reason,
          ip: clientIp(c),
          requestId,
          ...(actorAuthUserId ? { actorAuthUserId } : {}),
        });
        return refusalProblem(reason);
      };
      if (found.refusal || found.email === null) {
        throw await refuse(found.refusal ?? "invitation_closed", session?.authUserId);
      }
      let authUserId = session?.authUserId ?? null;
      let created = false;
      if (authUserId === null) {
        const existing = await services.authPool.query(
          'SELECT 1 FROM auth."user" WHERE lower(email) = $1',
          [found.email],
        );
        if ((existing.rowCount ?? 0) > 0) throw await refuse("sign_in_first");
        const weak = password === undefined ? "Choose a password." : passwordProblem(password);
        if (weak || !name || password === undefined) {
          throw problems.invalid(weak ?? "Enter your name.");
        }
        const ctx = await services.auth.$context;
        const hashed = await ctx.password.hash(password);
        const user = await ctx.internalAdapter.createUser(
          {
            email: found.email,
            name,
            // Holding the link proves the address (platform.md, Invitations step 3).
            emailVerified: true,
          },
          { method: "email-password" },
        );
        authUserId = user.id;
        created = true;
        let recorded = false;
        try {
          await ctx.internalAdapter.linkAccount({
            userId: user.id,
            providerId: "credential",
            accountId: user.id,
            password: hashed,
          });
          // Recorded and committed before the acceptance, so the sweep can find it if this stops.
          recorded = await recordSignIn(services.appPool, token, authUserId);
        } catch (error) {
          await removeSignIn(services, authUserId, "not_recorded", requestId);
          throw error;
        }
        if (!recorded) {
          await removeSignIn(services, authUserId, "not_recorded", requestId);
          throw await refuse("invitation_closed");
        }
      }
      let outcome: Awaited<ReturnType<typeof acceptInvitation>>;
      try {
        outcome = await acceptInvitation(services.appPool, token, authUserId);
      } catch (error) {
        if (created) await removeSignIn(services, authUserId, "acceptance_failed", requestId);
        throw error;
      }
      if ("refusal" in outcome) {
        if (created) await removeSignIn(services, authUserId, "acceptance_refused", requestId);
        if (outcome.refusal === "not_found")
          throw await unknownToken(c, "platform.invitation.accepted");
        throw await refuse(outcome.refusal, authUserId);
      }
      return c.json(
        { tenantId: outcome.tenantId, next: created ? "sign_in" : "enrol" } as const,
        200,
      );
    },
  );
