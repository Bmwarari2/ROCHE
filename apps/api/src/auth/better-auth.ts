import { passkey } from "@better-auth/passkey";
import { betterAuthSchema } from "@harbour/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Config } from "../config";
import { passwordProblem } from "./password-policy";
import { MOBILE_APP_ORIGIN } from "./token-exposure";

/**
 * Better Auth (ADR-0009): email and password with NCSC rules, passkeys (FIDO2) and TOTP as MFA,
 * bearer tokens for the mobile app. Runs on its own database role (harbour_auth) that can reach
 * only the auth schema. SMS is deliberately not offered as a second factor (section 5.3).
 */
export function createAuth(config: Config, authPool: pg.Pool) {
  const db = drizzle(authPool);
  const passkeyOrigin = config.webOrigins[0] ?? config.BETTER_AUTH_URL;

  return betterAuth({
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
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
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
      }),
    },
    plugins: [
      twoFactor({ issuer: "Harbour" }),
      passkey({ rpID: config.PASSKEY_RP_ID, rpName: "Harbour", origin: passkeyOrigin }),
      bearer(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
