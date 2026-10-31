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

## Tests

- `packages/domain/src/platform/sso.test.ts` (44, 25 new).
- `packages/db/test/sso.test.ts` (10): isolation, permission, shape, the definer functions.
- `apps/api/test/sso.test.ts` (22): configuration and refusals, step-up, DNS proof, the provider
  row with no secret, disabled plugin routes, the callback policy, a sign-in started with PKCE,
  HZ-112.

## Not in this slice

The screens (slice 67) and SAML.
