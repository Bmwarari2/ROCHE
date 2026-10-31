---
status: "accepted"
date: 2026-10-31
decision-makers: Thapsus engineering (Phase 2 slice 33)
consulted: security (H-750 reviews the threat model), data protection lead (H-752)
informed: CSO (HZ-112); lane E (SSO screens, slice 67)
---

# Single sign-on

## Context and problem statement

PLAT-005 asks for per-organisation single sign-on. The slice 9 rules (`sso.ts`, platform.md rules
15 to 17) already say who may sign in: an invited or active member, by an address the identity
provider verified, on a domain the organisation verified, holding only roles allowed to use SSO, and
never as a substitute for Harbour's own second factor (HZ-112). Section 5.3 keeps secrets only in
the managed store. How should Harbour run the protocol, hold the provider's configuration and
credentials, and link sign-ins to members?

## Decision drivers

- Secrets never in the database, the API or logs (section 5.3); the master prompt's stack uses
  Better Auth (ADR-0009), so sessions, MFA and step-up should keep working unchanged.
- Least privilege: only holders of `platform.tenant.manage`, with step-up, change sign-in for an
  organisation; nobody else, including Better Auth's own endpoints, may register a provider.
- Linking must never create a member or attach a different person's sign-in.
- No new sub-processor: the organisation's identity provider is the organisation's own.

## Considered options

- The Better Auth SSO plugin (`@better-auth/sso`, MIT), OpenID Connect first.
- A hand-written OpenID Connect client in the API.
- A hosted identity broker (Auth0, Cognito, WorkOS).

## Decision outcome

Chosen option: "the Better Auth SSO plugin", because it runs inside the existing auth service,
creates ordinary Better Auth sessions (so the session factor of ADR-0072 still decides care-record
and step-up access), supports PKCE and `private_key_jwt`, has an application hook to decide each
sign-in (`resolveUser`) and a key callback (`resolvePrivateKey`), and adds no sub-processor.

- **Configuration.** The organisation's own `sso_connection` and `sso_domain` (migration 0095,
  forced RLS, `platform.tenant.manage`) are the record. Better Auth's `auth.sso_provider` row is a
  projection the API writes after each change commits (a failure leaves sign-in off or on the
  previous settings, never ahead). The plugin's own provider and domain routes are switched off
  (`disabledPaths`).
- **Credentials.** Only `private_key_jwt`: the connection holds the key's name in AWS Secrets
  Manager, and `resolvePrivateKey` reads it at sign-in. Client-secret authentication is refused, so
  the plugin never stores a secret.
- **Discovery.** The API runs OpenID discovery when a connection is switched on, after the
  connection's own checks, with the plugin's SSRF guards fully on and nothing trusted: the
  discovery URL and every endpoint must be https on a public host that resolves to a public
  address, with no redirects, and the issuer must match; any failure gives the same generic error.
  The endpoints are stored. Identity providers are never Better Auth trusted origins: the plugin
  re-checks at sign-in that the token, key and user endpoints resolve to public addresses
  (security review #33, H1 and M2).
- **Linking.** `resolveUser` runs `ssoSignInDecision` with facts from `app.sso_sign_in_facts`, a
  definer function that reads the connection, the verified domains and the member with that address
  in the organisation the provider id names. An active member is linked to their existing sign-in;
  an invited member gets one, linked by `app.link_sso_member`, which re-checks the connection,
  domain and invitation state and audits; anyone else is refused in the rule's words.
- **One provider account, one sign-in.** `resolveUser` refuses a provider account (issuer and
  subject) already linked to another sign-in, through this provider or any other with the same
  issuer, and never creates a sign-in for an account that has one. An SSO session is bound to the
  organisation whose provider signed it in and reaches no other. A new issuer, client or discovery
  URL switches SSO off and unverifies every domain until each is proved again (#33 H2).
- **Domains.** Proved by a DNS TXT record whose token is kept only as a hash; a domain is verified by
  one organisation at a time; common public mail domains are refused.
- **Keys** are named under the organisation's own prefix, `harbour/sso/<tenant id>/<name>`, checked
  by the API and the database; existence is checked with `DescribeSecret`, never by reading the key
  (#33 M3).
- **Not offered:** the plugin's SAML routes and its provider-less callback are refused before Better
  Auth sees them (#33 L2). The plugin sends no OIDC `nonce`; PKCE (S256) and the state bind the code
  to the browser that started the sign-in, and a nonce is raised upstream (H-756; #33 L3).
- **SAML 2.0** is supported by the plugin but not switched on here; it follows when a design
  partner's provider needs it (H-753), with its own review.

- **Off until reviewed again.** The `platform.sso` flag (OpenFeature, off by default) gates the
  configuration API and Better Auth's SSO sign-in and callback; with it off, nothing about SSO
  answers (re-check of #33).
- **Session binding on the session row.** A session made by an SSO callback gets
  `auth.session.sso_tenant_id` in the same insert (a `session.create.before` hook, on every
  `/sso/` path; with no organisation, no session is made), so the binding cannot be missing or
  expire before the session. The tenant middleware refuses any other organisation.
- **An SSO session is held to a few routes.** On Better Auth's own routes it may read itself, sign
  out and confirm a Harbour authenticator code on itself (needed for HZ-112: care records and
  step-up ask for it); everything else (listing, linking, enrolling, passkey sign-in) answers
  `sso_session_limited`. No caller, the mobile app included, is given other sessions' tokens.
- **No implicit linking.** `accountLinking.disableImplicitLinking`; an invited member whose address
  already has a Harbour sign-in is told to sign in first, as invitations do.
- **Discovery by Harbour's own guard.** Issuer and URLs normalised (`normalizeUrl`); the discovery
  URL and every endpoint must be https on a host that resolves only to public addresses (private,
  loopback, link-local, shared, metadata, multicast and reserved ranges refused); no redirects; a
  bounded document. The plugin's trust function is never made to return true. Callback errors are
  made generic (`error=sso_sign_in_failed`).

### Consequences

- Good, because SSO sessions inherit sessions, MFA, step-up, revocation and audit as they are.
- Good, because no secret exists anywhere Harbour stores data.
- Bad, because each organisation's provider key must be put in Secrets Manager by Thapsus
  (H-751), and rotated there.
- Bad, because an owner can point their connection at any public https provider; a new issuer
  switches SSO off until the domains are proved again, every change needs step-up and is audited,
  and a provider account can never take over a sign-in it is not linked to (H-750).

### Confirmation

`packages/domain/src/platform/sso.test.ts`, `packages/db/test/sso.test.ts` (isolation, the definer
functions), `apps/api/test/sso.test.ts` (configuration, DNS proof, the callback policy, a real
sign-in start with PKCE, HZ-112).

## More information

[platform.md](../specs/platform.md) "Phase 2: single sign-on"; ADR-0009 (Better Auth), ADR-0072
(session factor).
