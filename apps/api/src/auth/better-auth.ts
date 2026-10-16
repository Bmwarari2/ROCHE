import { passkey } from "@better-auth/passkey";
import { betterAuthSchema } from "@harbour/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { bearer, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Config } from "../config";
import { passwordProblem } from "./password-policy";
import {
  codeFailures,
  FACTOR_CHANGE_ROUTES,
  FACTOR_ROUTES,
  IN_SESSION_CODE_ATTEMPTS,
  IN_SESSION_CODE_ROUTES,
  recordCodeFailure,
  recordSessionFactor,
  sessionMfa,
} from "./session-factor";
import { MOBILE_APP_ORIGIN } from "./token-exposure";

/** A session lasts 12 hours from its last refresh (platform.md, Identity). */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 12;
/** A session in use is refreshed (its expiry moved on) at most once an hour. */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

/**
 * Better Auth (ADR-0009): email and password with NCSC rules, passkeys (FIDO2) and TOTP as MFA,
 * bearer tokens for the mobile app. Runs on its own database role (harbour_auth) that can reach
 * only the auth schema. SMS is deliberately not offered as a second factor (section 5.3).
 */
export function createAuth(config: Config, authPool: pg.Pool) {
  const db = drizzle(authPool);
  const passkeyOrigin = config.webOrigins[0] ?? config.BETTER_AUTH_URL;
  // The session a request carries, resolved as the API does (cookie or bearer token). A user
  // `before` hook runs before the bearer plugin rewrites the header, so it asks the instance.
  const resolver: {
    session?: (headers: Headers) => Promise<{
      session: { id: string; expiresAt: Date };
      user: { id: string; twoFactorEnabled?: boolean | null };
    } | null>;
  } = {};

  const auth = betterAuth({
    appName: "Harbour",
    baseURL: config.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema: betterAuthSchema }),
    // The mobile app's deep-link scheme is an origin for Better Auth's CSRF checks.
    trustedOrigins: [...config.webOrigins, MOBILE_APP_ORIGIN],
    emailAndPassword: {
      enabled: true,
      // NCSC: at least 12 characters, a deny-list, no forced expiry; throttling, not lockout.
      minPasswordLength: 12,
      maxPasswordLength: 128,
      // Accounts are created by invitation in a tenant; open sign-up is off outside tests.
      disableSignUp: config.NODE_ENV === "production",
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      freshAge: config.STEP_UP_WINDOW_SECONDS,
    },
    rateLimit: {
      enabled: config.NODE_ENV !== "test",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/two-factor/verify-totp": { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: config.NODE_ENV === "production",
      cookiePrefix: "harbour",
      // Throttle per client address, not per platform (see TRUSTED_PROXY_CIDRS).
      ipAddress: { trustedProxies: [...config.trustedProxies] },
    },
    telemetry: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/sign-up/email" ||
          ctx.path === "/change-password" ||
          ctx.path === "/reset-password"
        ) {
          const body = (ctx.body ?? {}) as { password?: unknown; newPassword?: unknown };
          const candidate = typeof body.newPassword === "string" ? body.newPassword : body.password;
          if (typeof candidate === "string") {
            const problem = passwordProblem(candidate);
            if (problem)
              throw new APIError("BAD_REQUEST", { message: problem, code: "WEAK_PASSWORD" });
          }
        }
        const changesFactor = FACTOR_CHANGE_ROUTES.has(ctx.path);
        if (!changesFactor && !IN_SESSION_CODE_ROUTES.has(ctx.path)) return;
        const found = await resolver.session?.(
          ctx.request?.headers ?? ctx.headers ?? new Headers(),
        );
        if (!found) {
          // Changing a factor always needs a session; a code with none is a sign-in's second step.
          if (changesFactor) throw new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED" });
          return;
        }
        if (changesFactor) {
          // Once a factor is enrolled, only a session that used one may add, show or remove one
          // (#57 security review round 1, HZ-112); a first enrolment goes ahead.
          const mfa = await sessionMfa(authPool, {
            authUserId: found.user.id,
            sessionId: found.session.id,
            twoFactorEnabled: found.user.twoFactorEnabled === true,
          });
          if (mfa === "verify") {
            throw new APIError("FORBIDDEN", {
              message: "Sign in again with your passkey or authenticator app first.",
              code: "MFA_VERIFICATION_REQUIRED",
            });
          }
        } else if ((await codeFailures(authPool, found.session.id)) >= IN_SESSION_CODE_ATTEMPTS) {
          // Better Auth limits wrong codes only at sign-in; a session gets a few, then signs in again.
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many wrong codes. Sign in again to try more.",
            code: "TOO_MANY_ATTEMPTS",
          });
        }
      }),
      // A passkey or a verified authenticator code marks the session it signed in or confirmed, so
      // care records open only for a session that used a second factor (#43 review M5, ADR-0072).
      after: createAuthMiddleware(async (ctx) => {
        const factor = FACTOR_ROUTES.get(ctx.path);
        if (!factor) return;
        if (isAPIError(ctx.context.returned)) {
          // A wrong code on an existing session counts towards its limit (not at sign-in).
          const existing = ctx.context.session?.session;
          if (existing && IN_SESSION_CODE_ROUTES.has(ctx.path)) {
            await recordCodeFailure(authPool, existing.id, new Date(existing.expiresAt));
          }
          return;
        }
        const session = ctx.context.newSession?.session ?? ctx.context.session?.session;
        if (!session) return;
        await recordSessionFactor(authPool, session.id, factor, new Date(session.expiresAt));
      }),
    },
    plugins: [
      twoFactor({ issuer: "Harbour" }),
      passkey({ rpID: config.PASSKEY_RP_ID, rpName: "Harbour", origin: passkeyOrigin }),
      bearer(),
    ],
  });
  resolver.session = (headers) =>
    auth.api.getSession({ headers, query: { disableRefresh: true } }) as ReturnType<
      NonNullable<typeof resolver.session>
    >;
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
