import { tenantOfSsoProvider } from "@harbour/domain";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Services } from "../http/context";
import { ssoEnabledFor } from "../services/sso";
import { isBlockedSsoPath } from "./better-auth";
import { sessionSsoTenant } from "./session-factor";

/**
 * What a session made by single sign-on may do on Better Auth's own routes (#33 re-check H2):
 * read itself, sign out, and confirm a Harbour authenticator code on itself (HZ-112: care records
 * and step-up need it). Nothing that lists, links, enrols or mints another session.
 */
export const SSO_SESSION_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/sign-out",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
]);

const SIGN_IN = "/api/auth/sign-in/sso";
const CALLBACK = /^\/api\/auth\/sso\/callback\/([^/]+)$/;

const problem = (status: number, code: string, title: string) =>
  new Response(JSON.stringify({ type: "about:blank", status, code, title }), {
    status,
    headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
  });

/** The provider a sign-in or callback names, or null for any other auth route. */
async function providerOf(request: Request, path: string): Promise<string | null> {
  const callback = CALLBACK.exec(path);
  if (callback) return decodeURIComponent(callback[1] ?? "");
  if (path !== SIGN_IN || request.method !== "POST") return null;
  try {
    const body = (await request.clone().json()) as { providerId?: unknown };
    return typeof body.providerId === "string" ? body.providerId : "";
  } catch {
    return "";
  }
}

/**
 * The error a callback redirect carries, made generic: no addresses, TLS text or provider words.
 * Changed on the response itself: Hono's `c.res` setter copies the old headers over a new one.
 */
function makeCallbackErrorGeneric(response: Response): void {
  const location = response.headers.get("location");
  if (!location || !/[?&]error/.test(location)) return;
  const url = new URL(location, "http://placeholder.invalid");
  const target = location.startsWith("http") ? `${url.origin}${url.pathname}` : url.pathname;
  response.headers.set("location", `${target}?error=sso_sign_in_failed`);
}

/**
 * In front of Better Auth (ADR-0091): SAML and the provider-less callback are not offered;
 * SSO sign-in and callbacks run only for an organisation whose `platform.sso` flag is on; an SSO
 * session is held to its own few routes; callback errors say nothing specific.
 */
export function ssoAuthGate(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const request = c.req.raw;
    const path = new URL(request.url).pathname;
    if (isBlockedSsoPath(path)) return c.notFound();

    const providerId = await providerOf(request, path);
    if (providerId !== null) {
      const tenantId = tenantOfSsoProvider(providerId);
      if (!tenantId || !(await ssoEnabledFor(services, tenantId))) {
        return problem(404, "sso_not_available", "Single sign-on is not available here.");
      }
    } else if (
      !SSO_SESSION_AUTH_PATHS.has(path) &&
      (request.headers.has("cookie") || request.headers.has("authorization"))
    ) {
      const found = await services.auth.api
        .getSession({ headers: request.headers, query: { disableRefresh: true } })
        .catch(() => null);
      if (found && (await sessionSsoTenant(services.authPool, found.session.id)) !== null) {
        return problem(
          403,
          "sso_session_limited",
          "Sign in with your Harbour passkey or password to change your sign-in settings.",
        );
      }
    }
    await next();
    if (CALLBACK.test(path)) makeCallbackErrorGeneric(c.res);
  };
}
