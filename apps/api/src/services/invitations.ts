import { createHash, randomBytes } from "node:crypto";
import { type Database, withRequestContext } from "@harbour/db";
import { type AcceptRefusal, INVITATION_TOKEN_BYTES } from "@harbour/domain";
import type pg from "pg";
import { writeAudit } from "../http/audit";
import type { ChannelAdapter } from "../integrations/registry";
import type { Logger } from "../logger";

/**
 * Invitations (PLAT-004; platform.md, Invitations and MFA enrolment): the link's token, the
 * security-definer functions of migration 0054, the email and the nightly sweep. The raw token is
 * held only in memory: it goes to the definer functions as a bound parameter (never interpolated
 * into SQL), into the link in the email, and nowhere else; it is never logged or audited. Only its
 * SHA-256 is stored, hashed by the database itself on lookup and acceptance.
 */

/** A new link's token (256 bits, base64url) and the hash the database stores. */
export function newInvitationToken(): { readonly token: string; readonly hash: string } {
  const token = randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
  return { token, hash: invitationTokenHash(token) };
}

/** SHA-256 (hex) of the token's UTF-8 bytes, as `app.invitation_token_hash` computes it. */
export function invitationTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const ACCEPT_REFUSALS: ReadonlySet<AcceptRefusal> = new Set([
  "invitation_expired",
  "invitation_used",
  "invitation_revoked",
  "organisation_not_active",
  "member_not_invited",
  "email_mismatch",
  "already_member",
]);

/**
 * The refusal a definer function raised (its message is the code), `not_found` for an unknown
 * token, or null for any other error, which is rethrown.
 */
export function definerRefusal(error: unknown): AcceptRefusal | "not_found" | null {
  const message = (error as { message?: unknown }).message;
  if (message === "invitation_not_found") return "not_found";
  return typeof message === "string" && ACCEPT_REFUSALS.has(message as AcceptRefusal)
    ? (message as AcceptRefusal)
    : null;
}

export interface InvitationFound {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly organisationName: string;
  readonly emailMasked: string | null;
  /** The invited address while the invitation is open; null once closed. */
  readonly email: string | null;
  readonly expiresAt: Date;
  readonly refusal: AcceptRefusal | null;
}

/**
 * The invitation a token names, or null: `app.invitation_for_token` for what the page shows, and
 * `app.claim_invitation` in a transaction rolled back at once for the address, so nothing changes.
 */
export async function findInvitation(
  pool: pg.Pool,
  token: string,
): Promise<InvitationFound | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shown = await client.query<{
      invitation_id: string;
      tenant_id: string;
      organisation_name: string;
      email_masked: string | null;
      expires_at: Date;
      refusal: AcceptRefusal | null;
    }>("SELECT * FROM app.invitation_for_token($1)", [token]);
    const row = shown.rows[0];
    if (!row) return null;
    const claimed = await client.query<{ email: string | null }>(
      "SELECT email FROM app.claim_invitation($1)",
      [token],
    );
    return {
      invitationId: row.invitation_id,
      tenantId: row.tenant_id,
      organisationName: row.organisation_name,
      emailMasked: row.email_masked,
      email: claimed.rows[0]?.email ?? null,
      expiresAt: row.expires_at,
      refusal: row.refusal,
    };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Records a sign-in the acceptance created, committed on its own (`app.record_invitation_sign_in`). */
export async function recordSignIn(pool: pg.Pool, token: string, authUserId: string) {
  const result = await pool.query<{ recorded: boolean }>(
    "SELECT app.record_invitation_sign_in($1, $2) AS recorded",
    [token, authUserId],
  );
  return result.rows[0]?.recorded === true;
}

/**
 * Accepts in one transaction: `app.claim_invitation` locks the row and says why it cannot be
 * accepted, then `app.accept_invitation` links the member and audits. Returns the organisation, or
 * the refusal; any other error is thrown after the rollback.
 */
export async function acceptInvitation(
  pool: pg.Pool,
  token: string,
  authUserId: string,
): Promise<{ readonly tenantId: string } | { readonly refusal: AcceptRefusal | "not_found" }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query<{ refusal: AcceptRefusal | null }>(
      "SELECT refusal FROM app.claim_invitation($1)",
      [token],
    );
    const found = claim.rows[0];
    const refusal = found ? found.refusal : "not_found";
    if (refusal !== null) {
      await client.query("ROLLBACK");
      return { refusal };
    }
    const accepted = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM app.accept_invitation($1, $2)",
      [token, authUserId],
    );
    await client.query("COMMIT");
    return { tenantId: accepted.rows[0]?.tenant_id ?? "" };
  } catch (error) {
    await client.query("ROLLBACK");
    const refusal = definerRefusal(error);
    if (refusal === null) throw error;
    return { refusal };
  } finally {
    client.release();
  }
}

/** The plain-English subject of every invitation email: nothing about the person or anyone cared for. */
export const INVITATION_EMAIL_TITLE = "You have been invited to Harbour";

/**
 * Hands the link to the organisation's email adapter (the mock unless one is configured; in
 * production, unconfigured fails clearly). Never queued: the token is not stored anywhere a
 * delivery row could keep it. A failure is audited (opaque ids) and reported to the sender, who
 * sends again. True when sent.
 */
export async function sendInvitationEmail(
  deps: {
    readonly db: Database;
    readonly appPool: pg.Pool;
    readonly webOrigin: string;
    readonly adapterFor: (
      tenantId: string,
      channel: "email",
      tx: Parameters<Parameters<typeof withRequestContext>[2]>[0],
    ) => Promise<ChannelAdapter>;
  },
  invitation: { readonly id: string; readonly tenantId: string; readonly email: string },
  token: string,
  actor: { readonly actorAuthUserId: string; readonly requestId: string },
): Promise<boolean> {
  const result = await withRequestContext(
    deps.db,
    { tenantId: invitation.tenantId, userId: null, scope: "tenant", locationIds: [] },
    async (tx) => {
      const adapter = await deps.adapterFor(invitation.tenantId, "email", tx);
      return adapter.send({
        idempotencyKey: invitation.id,
        title: INVITATION_EMAIL_TITLE,
        link: `${deps.webOrigin}/invitation#${token}`,
        to: invitation.email,
      });
    },
  );
  if (!result.ok) {
    await audit(deps.appPool, invitation.tenantId, {
      action: "platform.invitation.email_failed",
      outcome: "error",
      resourceId: invitation.id,
      reason: result.retryable ? "retryable" : "not_retryable",
      ...actor,
    });
  }
  return result.ok;
}

/**
 * An audit event in an organisation's chain for a request with no member session there (a link
 * opened or accepted, an operator's invitation): opaque ids only.
 */
export async function audit(
  pool: pg.Pool,
  tenantId: string | null,
  event: {
    readonly action: string;
    readonly outcome?: "success" | "denied" | "error";
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly reason?: string;
    readonly actorAuthUserId?: string;
    readonly actorRoleKeys?: readonly string[];
    readonly scope?: Record<string, unknown>;
    readonly ip?: string | null;
    readonly requestId?: string;
  },
): Promise<void> {
  if (tenantId === null) {
    await writeAudit(pool, null, { resourceType: "invitation", ...event });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO audit_event (tenant_id, actor_auth_user_id, actor_role_keys, action, outcome,
         resource_type, resource_id, reason, scope, ip, request_id)
       VALUES ($1, $2, $3, $4, $5, 'invitation', $6, $7, $8, $9, $10)`,
      [
        tenantId,
        event.actorAuthUserId ?? null,
        event.actorRoleKeys ? [...event.actorRoleKeys] : null,
        event.action,
        event.outcome ?? "success",
        event.resourceId ?? null,
        event.reason ?? null,
        event.scope ?? null,
        event.ip ?? null,
        event.requestId ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const SIGN_IN_REMOVED_ACTION = "platform.invitation.sign_in_removed";

/** Deletes a sign-in an acceptance created (its sessions and accounts cascade), audited. */
export async function removeSignIn(
  pools: { readonly appPool: pg.Pool; readonly authPool: pg.Pool },
  authUserId: string,
  reason: string,
  requestId?: string,
): Promise<void> {
  await pools.authPool.query('DELETE FROM auth."user" WHERE id = $1', [authUserId]);
  await audit(pools.appPool, null, {
    action: SIGN_IN_REMOVED_ACTION,
    actorAuthUserId: "system",
    resourceType: "auth_user",
    resourceId: authUserId,
    reason,
    ...(requestId ? { requestId } : {}),
  });
}

/**
 * The nightly sweep (#43 review M4; #48 review H1): lapsed invitations are revoked as expired
 * (`app.sweep_expired_invitations`, audited per invitation inside), then each sign-in an acceptance
 * recorded and never linked (`app.unlinked_invitation_sign_ins`) is deleted through the auth role.
 */
export async function sweepInvitations(deps: {
  readonly workerPool: pg.Pool;
  readonly appPool: pg.Pool;
  readonly authPool: pg.Pool;
  readonly logger: Logger;
}): Promise<{ readonly expired: number; readonly signInsRemoved: number }> {
  const swept = await deps.workerPool.query<{ n: number }>(
    "SELECT app.sweep_expired_invitations() AS n",
  );
  const unlinked = await deps.workerPool.query<{ id: string }>(
    "SELECT id FROM app.unlinked_invitation_sign_ins() AS id",
  );
  for (const { id } of unlinked.rows) {
    await removeSignIn(deps, id, "unlinked_after_acceptance_stopped");
  }
  const counts = { expired: swept.rows[0]?.n ?? 0, signInsRemoved: unlinked.rows.length };
  deps.logger.info({ event: "invitation.sweep", ...counts }, "invitation sweep");
  return counts;
}
