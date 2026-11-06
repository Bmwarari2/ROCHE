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

/** What the session has proved: the MFA state, and whether a factor's last use is fresh. */
export interface SessionFactorState {
  readonly mfa: "satisfied" | "verify" | "enrol";
  /**
   * True when this session proved a second factor (a sign-in completed with one, or a code or
   * passkey confirmed on it) no more than the step-up window ago, judged on the database's clock.
   * Step-up counts from this, never from a password sign-in (ADR-0072 amendment, HZ-112).
   */
  readonly stepUpFresh: boolean;
}

/**
 * Whether the member must enrol a second factor, must confirm it on this session, or has, and
 * when the session last used it. `enrol`: neither an authenticator app nor a passkey is set up.
 * `verify`: one is, but this session did not use it (a password-only sign-in, a trusted device,
 * or a session from before this check). One query; a factor record older than the session's
 * expiry is moved on with it. Each use is its own row, so the latest `created_at` is the last use;
 * it is fresh while `now() - created_at <= windowSeconds` (inclusive, on the database's clock).
 */
export async function sessionFactorState(
  authPool: pg.Pool,
  session: {
    readonly authUserId: string;
    readonly sessionId: string;
    readonly twoFactorEnabled: boolean;
  },
  windowSeconds: number,
): Promise<SessionFactorState> {
  const { rows } = await authPool.query<{
    passkey: boolean;
    stale: boolean | null;
    factor_at: Date | null;
    fresh: boolean | null;
  }>(
    `SELECT EXISTS (SELECT 1 FROM auth.passkey WHERE user_id = $1) AS passkey,
            f.stale, f.factor_at, now() - f.factor_at <= make_interval(secs => $4) AS fresh
       FROM (SELECT bool_and(v.expires_at < s.expires_at) AS stale,
                    max(v.created_at) AS factor_at
               FROM auth.session s
               JOIN auth.verification v ON v.identifier = $3
                AND v.value IN ('passkey', 'totp', 'backup_code')
              WHERE s.id = $2 AND s.user_id = $1) f`,
    [session.authUserId, session.sessionId, factorIdentifier(session.sessionId), windowSeconds],
  );
  const row = rows[0];
  if (!session.twoFactorEnabled && !row?.passkey) return { mfa: "enrol", stepUpFresh: false };
  if (row?.factor_at === null || row?.factor_at === undefined) {
    return { mfa: "verify", stepUpFresh: false };
  }
  if (row.stale) {
    await authPool.query(
      `UPDATE auth.verification v SET expires_at = s.expires_at, updated_at = now()
         FROM auth.session s
        WHERE v.identifier = $1 AND s.id = $2 AND v.expires_at < s.expires_at
          AND v.value IN ('passkey', 'totp', 'backup_code')`,
      [factorIdentifier(session.sessionId), session.sessionId],
    );
  }
  return { mfa: "satisfied", stepUpFresh: row.fresh === true };
}

/** The MFA state alone (`sessionFactorState`). */
export async function sessionMfa(
  authPool: pg.Pool,
  session: {
    readonly authUserId: string;
    readonly sessionId: string;
    readonly twoFactorEnabled: boolean;
  },
): Promise<"satisfied" | "verify" | "enrol"> {
  return (await sessionFactorState(authPool, session, 0)).mfa;
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

/** Codes one session may send before it is refused (it signs in again to try more). */
export const IN_SESSION_CODE_ATTEMPTS = 5;

function attemptIdentifier(sessionId: string): string {
  return `session-factor-attempt:${sessionId}`;
}

/**
 * Takes one of the session's code attempts before the code is checked, or returns false when
 * none are left (#57 security review round 2). The count and the insert run under an advisory lock
 * on the session, so parallel requests on one token cannot all see the same count. A right code
 * clears them (`clearCodeAttempts`); they otherwise lapse with the session.
 */
export async function reserveCodeAttempt(
  authPool: pg.Pool,
  sessionId: string,
  expiresAt: Date,
): Promise<boolean> {
  const client = await authPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      attemptIdentifier(sessionId),
    ]);
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.verification WHERE identifier = $1",
      [attemptIdentifier(sessionId)],
    );
    const allowed = (rows[0]?.n ?? 0) < IN_SESSION_CODE_ATTEMPTS;
    if (allowed) {
      await client.query(
        `INSERT INTO auth.verification (id, identifier, value, expires_at)
         VALUES ($1, $2, 'attempt', $3)`,
        [randomUUID(), attemptIdentifier(sessionId), expiresAt],
      );
    }
    await client.query("COMMIT");
    return allowed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Clears the session's code attempts once a code is accepted. */
export async function clearCodeAttempts(authPool: pg.Pool, sessionId: string): Promise<void> {
  await authPool.query("DELETE FROM auth.verification WHERE identifier = $1", [
    attemptIdentifier(sessionId),
  ]);
}

/**
 * Wrong codes across all of a member's sessions (#33 re-check 2, M1; HZ-112). One session's
 * limit does not stop someone who can mint many sessions (an organisation's identity provider
 * can, for its members) from spreading guesses across them. So every code checked on a session
 * also takes an attempt for the member, and so does a sign-in's own code step (re-check 3), kept
 * in Postgres (every API instance sees the same count): the first `USER_CODE_FREE_ATTEMPTS` in an
 * hour go straight through, then each waits four times as long as the last (a minute, four,
 * then the cap of `USER_CODE_MAX_DELAY_SECONDS`), and no more than `USER_CODE_ATTEMPTS_PER_HOUR`
 * are checked in an hour. A throttle, never a lockout (NCSC password guidance): the member can
 * always try again later, and a right code clears the count. Product settings, not statutory
 * figures.
 */
export const USER_CODE_FREE_ATTEMPTS = 5;
export const USER_CODE_ATTEMPTS_PER_HOUR = 10;
export const USER_CODE_FIRST_DELAY_SECONDS = 60;
export const USER_CODE_MAX_DELAY_SECONDS = 900;

function userAttemptIdentifier(authUserId: string): string {
  return `user-factor-attempt:${authUserId}`;
}

/** The wait before the next code, given the attempts in the last hour and the age of the newest. */
export function userCodeWait(
  attemptsInHour: number,
  secondsSinceLast: number,
  secondsSinceOldest: number,
): number {
  if (attemptsInHour >= USER_CODE_ATTEMPTS_PER_HOUR) {
    return Math.max(1, Math.ceil(3600 - secondsSinceOldest));
  }
  if (attemptsInHour < USER_CODE_FREE_ATTEMPTS) return 0;
  const delay = Math.min(
    USER_CODE_FIRST_DELAY_SECONDS * 4 ** (attemptsInHour - USER_CODE_FREE_ATTEMPTS),
    USER_CODE_MAX_DELAY_SECONDS,
  );
  return secondsSinceLast >= delay ? 0 : Math.ceil(delay - secondsSinceLast);
}

/**
 * Takes one of the member's code attempts before the code is checked, or returns how many seconds
 * to wait. Counted and inserted under an advisory lock on the member, on the database's clock, so
 * parallel requests on any instance cannot all see the same count.
 */
export async function reserveUserCodeAttempt(
  authPool: pg.Pool,
  authUserId: string,
): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly retryAfter: number }> {
  const identifier = userAttemptIdentifier(authUserId);
  const client = await authPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identifier]);
    const { rows } = await client.query<{ n: number; since_last: number; since_oldest: number }>(
      `SELECT count(*)::int AS n,
              coalesce(extract(epoch FROM now() - max(created_at)), 0)::float8 AS since_last,
              coalesce(extract(epoch FROM now() - min(created_at)), 0)::float8 AS since_oldest
         FROM auth.verification
        WHERE identifier = $1 AND created_at > now() - interval '1 hour'`,
      [identifier],
    );
    const row = rows[0] ?? { n: 0, since_last: 0, since_oldest: 0 };
    const wait = userCodeWait(row.n, row.since_last, row.since_oldest);
    if (wait === 0) {
      await client.query(
        `INSERT INTO auth.verification (id, identifier, value, expires_at)
         VALUES ($1, $2, 'attempt', now() + interval '1 hour')`,
        [randomUUID(), identifier],
      );
    }
    await client.query("COMMIT");
    return wait === 0 ? { allowed: true } : { allowed: false, retryAfter: wait };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Clears the member's code attempts once a code is accepted. */
export async function clearUserCodeAttempts(authPool: pg.Pool, authUserId: string): Promise<void> {
  await authPool.query("DELETE FROM auth.verification WHERE identifier = $1", [
    userAttemptIdentifier(authUserId),
  ]);
}

/**
 * The organisation an SSO session belongs to, or null for a session that is not from SSO. Read
 * from the session Better Auth has just resolved (`ssoTenantId` is a session field, written in
 * the same insert as the session; #33 re-check H1), never from a second read of the row: a
 * request racing a sign-out or `endSsoSession` would find no row there and be taken for a
 * session that is not from SSO, skipping the flag check, the organisation binding and the
 * operator refusal (#33 re-check 3, L).
 */
export function ssoTenantOf(session: object): string | null {
  const value = (session as { ssoTenantId?: unknown }).ssoTenantId;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Ends an SSO session (#33 re-check 2): when its organisation's `platform.sso` flag has been
 * switched off, its live sessions end at their next request rather than lasting to expiry.
 */
export async function endSsoSession(authPool: pg.Pool, sessionId: string): Promise<void> {
  await authPool.query("DELETE FROM auth.session WHERE id = $1 AND sso_tenant_id IS NOT NULL", [
    sessionId,
  ]);
}
