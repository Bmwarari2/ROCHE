import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { betterAuthSchema } from "@harbour/db";
import { tenantOfSsoProvider } from "@harbour/domain";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { bearer, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Config } from "../config";
import type { SsoHooks } from "../services/sso";
import { passwordProblem } from "./password-policy";
import {
  clearCodeAttempts,
  FACTOR_CHANGE_ROUTES,
  FACTOR_ROUTES,
  IN_SESSION_CODE_ROUTES,
  recordSessionFactor,
  recordSessionSsoTenant,
  reserveCodeAttempt,
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
/**
 * The SSO plugin's own provider routes: switched off, so only the API's `/v1/sso` routes (holders
 * of platform.tenant.manage, with step-up) configure single sign-on (ADR-0091, rule 22).
 */
export const SSO_DISABLED_PATHS: readonly string[] = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
];

/** SSO routes refused before Better Auth sees them: SAML, and the callback with no provider. */
export function isBlockedSsoPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "");
  return path === "/api/auth/sso/callback" || path.startsWith("/api/auth/sso/saml2/");
}

export function createAuth(config: Config, authPool: pg.Pool, ssoHooks?: SsoHooks) {
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
  // Requests confirming a code while no factor was enrolled: the code completes a first enrolment,
  // which proves only the password, so it records no factor (#63 security review, M1). Keyed by the
  // request, so each request decides for itself: a parallel code on the same session cannot clear
  // or reuse another's verdict (#63 round 2). The person then confirms a code on the session, or
  // signs in with the new factor, before step-up or care records count it.
  const firstEnrolments = new WeakSet<Request>();

  const auth = betterAuth({
    appName: "Harbour",
    baseURL: config.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    // Transactions let the SSO resolver run inside the callback (#33 review M1).
    database: drizzleAdapter(db, { provider: "pg", schema: betterAuthSchema, transaction: true }),
    // The mobile app's deep-link scheme is an origin for Better Auth's CSRF checks.
    // Identity providers are never trusted origins: the plugin fetches their endpoints only when
    // they resolve to public addresses (#33 review H1, M2). SSO_TEST_IDP_ORIGINS exists for the
    // end-to-end test's local provider and is refused in production.
    trustedOrigins: [...config.webOrigins, MOBILE_APP_ORIGIN, ...config.ssoTestIdpOrigins],
    disabledPaths: [...SSO_DISABLED_PATHS],
    // An invited member signing in with SSO for the first time gets a sign-in, which is then
    // linked to their membership (rule 20). The account's provider id names the organisation.
    databaseHooks: {
      account: {
        create: {
          after: async (account) => {
            if (ssoHooks && account.providerId.startsWith("harbour-")) {
              await ssoHooks.linkInvitedMember(account.providerId, account.userId);
            }
          },
        },
      },
    },
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
        "/sign-in/email": { window: 60, max: config.AUTH_SIGN_IN_PER_MINUTE },
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
        } else if (
          !(await reserveCodeAttempt(authPool, found.session.id, new Date(found.session.expiresAt)))
        ) {
          // Better Auth limits wrong codes only at sign-in; a session gets a few, then signs in again.
          // The attempt is taken before the code is checked, so parallel requests cannot pass it.
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many wrong codes. Sign in again to try more.",
            code: "TOO_MANY_ATTEMPTS",
          });
        } else {
          const enrolled = await sessionMfa(authPool, {
            authUserId: found.user.id,
            sessionId: found.session.id,
            twoFactorEnabled: found.user.twoFactorEnabled === true,
          });
          if (enrolled === "enrol" && ctx.request) firstEnrolments.add(ctx.request);
        }
      }),
      // A passkey or a verified authenticator code marks the session it signed in or confirmed, so
      // care records open only for a session that used a second factor (#43 review M5, ADR-0072).
      after: createAuthMiddleware(async (ctx) => {
        // A session from an SSO callback is bound to the provider's organisation (#33 review H2).
        if (ctx.path === "/sso/callback/:providerId" || ctx.path.startsWith("/sso/callback/")) {
          const created = ctx.context.newSession?.session;
          const providerId = (ctx.params as { providerId?: string } | undefined)?.providerId ?? "";
          const tenantId = tenantOfSsoProvider(providerId);
          if (created && tenantId) {
            await recordSessionSsoTenant(
              authPool,
              created.id,
              tenantId,
              new Date(created.expiresAt),
            );
          }
          return;
        }
        const factor = FACTOR_ROUTES.get(ctx.path);
        if (!factor) return;
        const existing = ctx.context.session?.session;
        // A code on an existing session counts only when this request saw a factor enrolled; with
        // no request to tell by, it fails closed.
        const firstEnrolment =
          existing !== undefined &&
          IN_SESSION_CODE_ROUTES.has(ctx.path) &&
          (!ctx.request || firstEnrolments.has(ctx.request));
        if (isAPIError(ctx.context.returned)) return;
        if (existing && IN_SESSION_CODE_ROUTES.has(ctx.path)) {
          await clearCodeAttempts(authPool, existing.id);
        }
        if (firstEnrolment) return;
        const session = ctx.context.newSession?.session ?? ctx.context.session?.session;
        if (!session) return;
        await recordSessionFactor(authPool, session.id, factor, new Date(session.expiresAt));
      }),
    },
    plugins: [
      twoFactor({ issuer: "Harbour" }),
      passkey({ rpID: config.PASSKEY_RP_ID, rpName: "Harbour", origin: passkeyOrigin }),
      bearer(),
      // OpenID Connect per organisation (ADR-0091). Keys come from the managed store at sign-in;
      // the callback runs the SSO policy (rules 15, 16, 20). Without hooks (scripts), no
      // provider resolves and every SSO sign-in is refused.
      sso({
        // The provider's email_verified claim is passed to resolveUser, which refuses an
        // unverified address (rule 15); the plugin itself would refuse every sign-in otherwise.
        trustEmailVerified: true,
        resolvePrivateKey: async ({ providerId }) =>
          (await ssoHooks?.resolvePrivateKey({ providerId })) ?? {},
        resolveUser: async (input) =>
          ssoHooks
            ? ssoHooks.resolveUser({
                providerId: input.providerId,
                accountKey: input.accountKey,
                providerUser: {
                  email: input.providerUser.email,
                  emailVerified: input.providerUser.emailVerified,
                },
              })
            : { action: "reject", code: "sso_off" },
      }),
    ],
  });
  resolver.session = (headers) =>
    auth.api.getSession({ headers, query: { disableRefresh: true } }) as ReturnType<
      NonNullable<typeof resolver.session>
    >;
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
