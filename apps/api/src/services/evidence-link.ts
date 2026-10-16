import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  auditEvent,
  type Database,
  evidencePack,
  evidencePackLink,
  type Transaction,
  withRequestContext,
} from "@harbour/db";
import {
  EVIDENCE_LINK_CODE_DIGITS,
  type EvidencePackLinkSession,
  type EvidencePackLinkView,
  type EvidencePackState,
} from "@harbour/domain";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { evidenceLinkTokenHash } from "./evidence-pack";

/**
 * The public side of an evidence pack link (ADR-0050; quality.md section 15; HZ-050): finding a
 * link by its token's hash, one-time codes kept only as an HMAC under the server key, the signed
 * session cookie that holds a verified recipient, and the link session the routes run in
 * (migration 0058: that link and its pack alone, no member, scope 'none'). The token and codes are
 * never logged, audited or stored; only their digests reach the database.
 */

/** The link the token names, and its organisation and pack; null for an unknown token. */
export interface FoundLink {
  readonly tenantId: string;
  readonly linkId: string;
  readonly packId: string;
}

/** `app.evidence_pack_link_for_token` with the SHA-256 the API works out, never the token. */
export async function findLinkByToken(pool: pg.Pool, token: string): Promise<FoundLink | null> {
  const { rows } = await pool.query<{ tenant_id: string; link_id: string; pack_id: string }>(
    "SELECT tenant_id, link_id, pack_id FROM app.evidence_pack_link_for_token($1)",
    [evidenceLinkTokenHash(token)],
  );
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, linkId: row.link_id, packId: row.pack_id } : null;
}

/** Runs `fn` as the link session: that organisation, that link and its pack, nothing else. */
export function inLinkSession<T>(
  db: Database,
  link: FoundLink,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withRequestContext(
    db,
    {
      tenantId: link.tenantId,
      userId: null,
      scope: "none",
      locationIds: [],
      evidenceLink: { linkId: link.linkId, packId: link.packId },
    },
    fn,
  );
}

/** The link as `evidencePackLinkAccess` reads it, locked for this transaction's attempt. */
export async function linkView(
  tx: Transaction,
  linkId: string,
): Promise<EvidencePackLinkView | null> {
  const [row] = await tx
    .select({
      id: evidencePackLink.id,
      packState: evidencePack.state,
      recipientEmail: evidencePackLink.recipientEmail,
      expiresAt: evidencePackLink.expiresAt,
      revokedAt: evidencePackLink.revokedAt,
      failedCodeAttempts: evidencePackLink.failedCodeAttempts,
    })
    .from(evidencePackLink)
    .innerJoin(evidencePack, eq(evidencePack.id, evidencePackLink.packId))
    .where(eq(evidencePackLink.id, linkId))
    .for("update", { of: evidencePackLink });
  return row ? { ...row, packState: row.packState as EvidencePackState } : null;
}

// ------------------------------------------------------------------------------------------------
// Codes (rule 8)
// ------------------------------------------------------------------------------------------------

/**
 * Why: a recipient may ask again if an email is slow, but no more than this many codes are open
 * for one link at once, so asking cannot flood a mailbox or widen a guesser's odds. A security
 * limit, not a tenant setting.
 */
export const MAX_LIVE_CODES_PER_LINK = 3;

/** Six digits from the platform's cryptographic random source. */
export function newEvidenceCode(): string {
  return String(randomInt(0, 10 ** EVIDENCE_LINK_CODE_DIGITS)).padStart(
    EVIDENCE_LINK_CODE_DIGITS,
    "0",
  );
}

/** HMAC-SHA256 (hex) of the code, bound to its link, under the server key: all that is stored. */
export function evidenceCodeHash(secret: string, linkId: string, code: string): string {
  return createHmac("sha256", secret).update(`evidence-code:${linkId}:${code}`).digest("hex");
}

/** Whether `entered` matches any of the stored hashes, comparing each in constant time. */
export function codeMatches(
  secret: string,
  linkId: string,
  entered: string,
  stored: readonly { readonly id: string; readonly codeHash: string }[],
): string | null {
  const candidate = Buffer.from(evidenceCodeHash(secret, linkId, entered), "hex");
  let matched: string | null = null;
  for (const code of stored) {
    const hash = Buffer.from(code.codeHash, "hex");
    if (hash.length === candidate.length && timingSafeEqual(hash, candidate) && matched === null) {
      matched = code.id;
    }
  }
  return matched;
}

// ------------------------------------------------------------------------------------------------
// The session cookie (rule 8: HttpOnly, Secure, SameSite=Strict, this link alone)
// ------------------------------------------------------------------------------------------------

export const EVIDENCE_SESSION_COOKIE = "harbour_evidence_session";

export interface LinkSessionCookie extends FoundLink, EvidencePackLinkSession {
  readonly expiresAt: number;
}

const sign = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(`evidence-session:${payload}`).digest("base64url");

export function signLinkSession(secret: string, session: LinkSessionCookie): string {
  const payload = Buffer.from(
    JSON.stringify({
      t: session.tenantId,
      l: session.linkId,
      p: session.packId,
      e: session.verifiedEmail,
      x: session.expiresAt,
    }),
  ).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session the cookie holds, if its signature is ours and it has not lapsed; else null. */
export function readLinkSession(
  secret: string,
  value: string | undefined,
  now: number = Date.now(),
): LinkSessionCookie | null {
  if (!value || value.length > 1024) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const { t, l, p, e, x } = parsed;
    if (
      typeof t !== "string" ||
      typeof l !== "string" ||
      typeof p !== "string" ||
      typeof e !== "string" ||
      typeof x !== "number" ||
      !UUID.test(t) ||
      !UUID.test(l) ||
      !UUID.test(p) ||
      x <= now
    ) {
      return null;
    }
    return { tenantId: t, linkId: l, packId: p, verifiedEmail: e, expiresAt: x };
  } catch {
    return null;
  }
}

/** An audit event in the organisation's chain for a link request: opaque ids only. */
export function auditLink(
  tx: Transaction,
  link: FoundLink,
  action: string,
  extra: {
    readonly outcome?: "success" | "denied" | "error";
    readonly reason?: string;
    readonly ip?: string | null;
    readonly requestId?: string;
    readonly scope?: Record<string, unknown>;
  } = {},
) {
  return tx.insert(auditEvent).values({
    tenantId: link.tenantId,
    action,
    outcome: extra.outcome ?? "success",
    resourceType: "evidence_pack_link",
    resourceId: link.linkId,
    reason: extra.reason ?? null,
    ip: extra.ip ?? null,
    requestId: extra.requestId ?? null,
    scope: { packId: link.packId, ...extra.scope },
  });
}
