import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * The second factor a session proved (#43 review M5, ADR-0072). MFA counts for care records only
 * when the session itself was signed in or confirmed with one of these, never merely because the
 * member has one enrolled. A backup code is the recovery code issued with the authenticator app.
 */
export type SessionFactor = "passkey" | "totp" | "backup_code";

/** The Better Auth routes that prove a second factor, and the factor each proves. */
export const FACTOR_ROUTES: ReadonlyMap<string, SessionFactor> = new Map([
  ["/passkey/verify-authentication", "passkey"],
  ["/two-factor/verify-totp", "totp"],
  ["/two-factor/verify-backup-code", "backup_code"],
]);

/**
 * The record lives in Better Auth's own `auth.verification` table (no new column, so no
 * migration), keyed by the session id. It expires with the session; Better Auth sweeps expired
 * rows, and a record swept early only fails closed (the person confirms it is them again).
 */
export function factorIdentifier(sessionId: string): string {
  return `session-factor:${sessionId}`;
}

/** Records that the session proved a second factor. Called only after Better Auth accepted it. */
export async function recordSessionFactor(
  authPool: pg.Pool,
  sessionId: string,
  factor: SessionFactor,
  expiresAt: Date,
): Promise<void> {
  await authPool.query(
    `INSERT INTO auth.verification (id, identifier, value, expires_at) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), factorIdentifier(sessionId), factor, expiresAt],
  );
}

/**
 * Whether the member must enrol a second factor, must confirm it on this session, or has.
 * `enrol`: neither an authenticator app nor a passkey is set up. `verify`: one is, but this session
 * did not use it (a password-only sign-in, a trusted device, or a session from before this check).
 * One query; a factor record older than the session's expiry is moved on with it.
 */
export async function sessionMfa(
  authPool: pg.Pool,
  session: {
    readonly authUserId: string;
    readonly sessionId: string;
    readonly twoFactorEnabled: boolean;
  },
): Promise<"satisfied" | "verify" | "enrol"> {
  const { rows } = await authPool.query<{ passkey: boolean; stale: boolean | null }>(
    `SELECT EXISTS (SELECT 1 FROM auth.passkey WHERE user_id = $1) AS passkey,
            (SELECT v.expires_at < s.expires_at
               FROM auth.verification v JOIN auth.session s ON s.id = $2 AND s.user_id = $1
              WHERE v.identifier = $3 AND v.value IN ('passkey', 'totp', 'backup_code')
              ORDER BY v.expires_at DESC LIMIT 1) AS stale`,
    [session.authUserId, session.sessionId, factorIdentifier(session.sessionId)],
  );
  const row = rows[0];
  if (!session.twoFactorEnabled && !row?.passkey) return "enrol";
  if (row?.stale === null || row?.stale === undefined) return "verify";
  if (row.stale) {
    await authPool.query(
      `UPDATE auth.verification v SET expires_at = s.expires_at, updated_at = now()
         FROM auth.session s
        WHERE v.identifier = $1 AND s.id = $2 AND v.expires_at < s.expires_at
          AND v.value IN ('passkey', 'totp', 'backup_code')`,
      [factorIdentifier(session.sessionId), session.sessionId],
    );
  }
  return "satisfied";
}

/**
 * Routes that add, reveal or remove a second factor (#57 security review round 1, HZ-112). Once a
 * member has a factor, these need a session that used one; otherwise a password alone could enrol
 * the attacker's own authenticator or passkey, or remove the member's, and then sign in with it.
 * Only a first enrolment (nothing enrolled yet) goes ahead on a password session.
 */
export const FACTOR_CHANGE_ROUTES: ReadonlySet<string> = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
  "/two-factor/view-backup-codes",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
]);

/** Routes that check a code on a session that already exists (Better Auth skips its lockout). */
export const IN_SESSION_CODE_ROUTES: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

/** Wrong codes one session may send before it is refused (it signs in again to try more). */
export const IN_SESSION_CODE_ATTEMPTS = 5;

function failureIdentifier(sessionId: string): string {
  return `session-factor-failure:${sessionId}`;
}

/** Counts a wrong code sent on an existing session; the count lapses with the session. */
export async function recordCodeFailure(
  authPool: pg.Pool,
  sessionId: string,
  expiresAt: Date,
): Promise<void> {
  await authPool.query(
    `INSERT INTO auth.verification (id, identifier, value, expires_at) VALUES ($1, $2, 'failure', $3)`,
    [randomUUID(), failureIdentifier(sessionId), expiresAt],
  );
}

/** How many wrong codes this session has sent. */
export async function codeFailures(authPool: pg.Pool, sessionId: string): Promise<number> {
  const { rows } = await authPool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM auth.verification WHERE identifier = $1",
    [failureIdentifier(sessionId)],
  );
  return rows[0]?.n ?? 0;
}
