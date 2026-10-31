# Single sign-on (Phase 2 slice 33)

Branch `feat/platform-sso`. PLAT-005 (partial: OpenID Connect; SAML later, H-753); [ADR-0091](../decisions/0091-single-sign-on.md).

## What changed

- Spec: [platform.md](../specs/platform.md) "Phase 2: single sign-on" (rules 18 to 22, permission
  matrix, test list).
- Schema: `sso_connection` and `sso_domain` (`packages/db/src/schema/sso.ts`) and Better Auth's
  `auth.sso_provider` in one migration, 0095. Forced RLS, the tenant policy and a restrictive
  `platform.tenant.manage` policy; one connection per organisation; https and a store name for the
  key enforced by checks; a domain verified by one organisation at a time; no DELETE. Two definer
  functions, `app.sso_sign_in_facts` and `app.link_sso_member`, owned by
  `harbour_invitation_owner`, listed in the definer ACL test.
- Rules: `checkSsoConnection`, `checkSsoDomain`, `ssoDomainRecord`, `ssoDomainProved`,
  `ssoProviderId` and `tenantOfSsoProvider` in `sso.ts`, beside the slice 9 policy.
- Auth: the Better Auth SSO plugin (`@better-auth/sso` 1.7.7, MIT). `private_key_jwt` only, keys
  read from AWS Secrets Manager at sign-in (`@aws-sdk/client-secrets-manager`); `resolveUser` runs
  the slice 9 policy; invited members are linked after their sign-in is created; the plugin's own
  provider routes are switched off; providers' origins are trusted only on the SSO paths.
- API: `GET /v1/sso`, `PUT /v1/sso/connection`, `POST /v1/sso/domains`,
  `POST /v1/sso/domains/{id}/verify`, `POST /v1/sso/domains/{id}/remove`, all `platform.tenant.manage`,
  changes with step-up, audited without key names, tokens or domains. OpenAPI and client
  regenerated. Config: `SSO_KEY_STORE` (`aws` required in production), `SSO_LOOKUPS`.
- Hazard log: HZ-112 control and tests for SSO. Records of processing, data standards, feature
  register, human actions H-750 to H-755.

## Security review (#33)

- H1: discovery with the plugin's SSRF guards fully on (nothing trusted), after the connection's
  checks, with a generic error; `ssoTrustedOrigins` removed (also M2: no provider is ever a trusted
  origin).
- H2: one provider account, one sign-in (checked across providers with the same issuer); an SSO
  session is bound to its organisation (`session-sso-tenant` record, enforced in the tenant
  middleware); a new issuer, client or discovery URL switches SSO off and unverifies the domains
  (database trigger).
- M1: `trustEmailVerified` (the resolver checks the claim) and adapter transactions; a real
  callback test against a local mock provider (`test/sso-callback.test.ts`).
- M3: keys under `harbour/sso/<tenant id>/` (API and database check), `DescribeSecret` for
  existence; IAM tag condition in H-751.
- L1: `link_sso_member` needs the provider's `auth.account` row; definer calls go through
  `withRequestContext`; the facts function returns no address or key name (`app.sso_key_ref` gives
  the key's name for a switched-on connection only). L2: SAML routes and the provider-less callback
  refused before Better Auth. L3: the plugin has no nonce; recorded in ADR-0091 and H-756.

## Re-check (#33): a simpler design

- `platform.sso` flag, off by default, gates `/v1/sso` and Better Auth's SSO sign-in and callback.
- The SSO tenant lives on `auth.session.sso_tenant_id` (migration 0095), written in the insert by a
  `session.create.before` hook on every `/sso/` path; the tenant middleware refuses any other.
- An SSO session may use only get-session, sign-out and the two code-confirmation routes on Better
  Auth; `list-sessions` never returns tokens, to anyone.
- `disableImplicitLinking`, and `sign_in_first` when the address already has a sign-in.
- Discovery by Harbour's own guard (normalised URLs, https, public addresses only, no redirects,
  bounded), with a test against a public-looking mock and private ones.
- Generic callback errors; production names the refused SSO setting; issuers normalised before
  comparing; egress controls in H-751.

## Re-check 2 (#33)

- M1 (HZ-112): wrong authenticator and backup codes counted per member across every session, in
  Postgres, with doubling waits after five and a cap of ten an hour; a throttle, not a lockout. The
  sign-in step itself (password, then code) keeps Better Auth's own handling and the sign-in
  throttles.
- Switching `platform.sso` off ends live SSO sessions (tenant middleware and the auth gate delete
  them); the operator console refuses SSO sessions.
- Discovery pins the address it checked (a `lookup` on the connection that refuses non-public
  addresses, through `node:https`, so no new dependency) and enforces the 256 KB cap while the
  body streams.

## Re-check 3 (#33)

- Switching `platform.sso` off now refuses and ends SSO sessions in the session middleware, so no
  `/v1` route (the tenantless ones included) accepts one or moves its expiry on while the flag is
  off.
- The sign-in's own code step counts against the member's hourly codes; the waits are a minute,
  four, then the 15-minute cap.
- Follow-ups logged under HZ-112: a holder of one session can use up the member's hourly codes; the
  plugin's sign-in fetches are not pinned against DNS rebinding.

## Tests

- `packages/domain/src/platform/sso.test.ts` (44, 25 new).
- `packages/db/test/sso.test.ts` (10): isolation, permission, shape, the definer functions.
- `apps/api/test/sso.test.ts` (22): configuration and refusals, step-up, DNS proof, the provider
  row with no secret, disabled plugin routes, the callback policy, a sign-in started with PKCE,
  HZ-112.

## Not in this slice

The screens (slice 67) and SAML.
