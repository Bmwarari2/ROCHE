---
status: "accepted"
date: 2026-10-11
decision-makers: Claude Code (build), Brian (product owner, informed)
consulted: security-reviewer agent
informed: Brian
---

# Web sessions, token exposure and the browser security policy

## Context and problem statement

The web app (Next.js) and the mobile app (Expo) share one Better Auth deployment (ADR-0009). The
bearer plugin, needed by the mobile app, returns the session token in a `set-auth-token` header and
in `token` fields of JSON bodies; with that plugin a token is a complete credential. If a browser
receives it, any script injected into a page can read it and act as the person until the session
expires, which defeats the httpOnly cookie. The web shell also needs a Content Security Policy
(ASVS 5.0 V3.4), a way to reach the API, and session management without handling tokens (master
prompt sections 5.3 and 9.1).

## Decision drivers

- Section 5.3 and ASVS 5.0 V7: session secrets never readable by page scripts.
- One container image promoted through dev, staging and prod (infra/README.md release steps).
- Least exposure: the browser should reach only what it needs.
- No third-party scripts; no `unsafe-inline` scripts.

## Considered options

- Strip tokens from Better Auth responses unless the caller is the mobile app (chosen).
- Run a separate Better Auth instance for mobile without the bearer plugin on the web path.
- Accept the default and rely on the CSP alone.

## Decision outcome

Chosen option: "strip tokens unless the caller is the mobile app", because it keeps one identity
store and one session table, needs no change in the mobile app (it already sends
`Origin: harbour://`, which page scripts cannot forge), and closes the gap at the API for every
non-mobile caller, including the web server.

Together with it:

1. **Tokens.** `apps/api/src/auth/token-exposure.ts` removes `set-auth-token` and every `token`
   field from `/api/auth/*` responses unless `Origin` is `harbour://`; CORS no longer exposes the
   header.
2. **Devices.** The web lists and signs out devices by session id through `GET /v1/me/sessions`,
   `POST /v1/me/sessions/{id}/revoke` and `POST /v1/me/sessions/revoke-others`; these are
   identity-level, need no organisation and never return tokens.
3. **Reaching the API.** Pages and server actions call the API from the web server with the
   person's cookie. The browser reaches only `/api/auth/*`, passed through by a route handler that
   reads the API address when the server starts (`API_BASE_URL` or `API_URL`), so one image serves
   every environment. `/v1` is not reachable from the browser origin.
4. **Content Security Policy.** `src/proxy.ts` sets a fresh 128-bit nonce per page with
   `'strict-dynamic'`; no `unsafe-inline` scripts; `unsafe-eval` only in development. Styles allow
   inline attributes because Radix positions menus with them. Every page renders dynamically so
   Next.js can apply the nonce.
5. **Cookies.** The organisation cookie is httpOnly; the location cookie is readable by the page
   (it only holds a location id the person may see); both are cleared on sign-out.
6. **Throttling.** Sign-in throttling uses the client address resolved through trusted proxies
   (`TRUSTED_PROXY_CIDRS`: the VPC, the NAT gateways and CloudFront's origin-facing ranges), not one
   shared bucket for the platform.

### Consequences

- Good, because a script injected into a page cannot obtain a reusable credential.
- Good, because the same web image runs in every environment.
- Bad, because a future browser feature that needs the token (none planned) would need its own
  server-side route.
- Neutral, because the Better Auth client in the browser still works: it never needed the token.

### Confirmation

- `apps/api/test/api.test.ts`: "session tokens stay out of browsers (ASVS V7)" and "signed-in
  devices (/v1/me/sessions)".
- `apps/web/src/lib/csp.test.ts`, `apps/web/src/lib/api-proxy.test.ts`.
- `apps/web/e2e/smoke.spec.ts`: the per-request nonce journey (no CSP violations) and the check
  that `/v1` is not reachable from the browser origin; `e2e/security.spec.ts` signs out another
  device.

## More information

Revisit if the mobile app moves to cookie sessions, or if Better Auth gains a per-client option to
withhold tokens. Related: ADR-0009 (Better Auth), ADR-0028 (certificate pinning),
[security checklist](../compliance/security-checklist.md).
