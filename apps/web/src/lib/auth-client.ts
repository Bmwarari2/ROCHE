import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth in the browser. Requests go to /api/auth on this origin, which a route handler
 * passes to the API, so the session cookie is first-party and httpOnly.
 */
function create() {
  return createAuthClient({
    baseURL: window.location.origin,
    basePath: "/api/auth",
    plugins: [twoFactorClient(), passkeyClient()],
  });
}

export type AuthClient = ReturnType<typeof create>;

let client: AuthClient | undefined;

/** The browser auth client, created on first use (never during server rendering). */
export function authClient(): AuthClient {
  if (typeof window === "undefined") {
    throw new Error("The auth client is only available in the browser");
  }
  client ??= create();
  return client;
}
