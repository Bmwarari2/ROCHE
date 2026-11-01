---
status: accepted; partly superseded by ADR-0098
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Identity provider: Better Auth, with Keycloak as the documented alternative

> **Partly superseded by [ADR-0098](0098-production-on-google-cloud.md) (production on Google
> Cloud), 31/10/2026**: the location of identity data, which now sits in the same europe-west2 Cloud
> SQL database under the same backups and audit. The text below is kept as decided.

## Context and problem statement

Harbour needs passkeys (FIDO2), TOTP multi-factor authentication, device sessions, organisation
(tenant) membership, SAML or OIDC single sign-on for enterprise tenants and, later, NHS CIS2 for staff
using GP Connect. Should identity be a library inside the API or a separate identity server?

## Decision drivers

- NCSC-grade MFA (passkeys and TOTP; SMS only as a documented exception) and step-up re-authentication.
- Identity data must stay in the UK with the rest of the tenant's data.
- A small team should not run a separate identity server unless a client demands it.
- Licence on the allowlist.

## Considered options

- Better Auth (MIT), embedded in `apps/api`, storing identity tables in Harbour's Postgres.
- Keycloak (Apache-2.0), self-hosted identity server.
- A hosted identity service.

## Decision outcome

Chosen option: "Better Auth", because it is the Appendix default and provides organisations, passkeys,
TOTP and device sessions without another server to run; SAML and OIDC come through the Better Auth SSO
plugin or WorkOS.

### Consequences

- Good, because identity data sits in the same eu-west-2 Postgres under the same backups and audit.
- Good, because the API owns sessions, so step-up checks and break-glass are one code path.
- Bad, because Better Auth is younger than Keycloak; Harbour wraps it behind an internal auth interface
  in `apps/api` so a swap to Keycloak changes the adapter, not the modules.
- Tenancy is enforced by Harbour's own RLS and scope model (ADR-0002); Better Auth organisations map
  to tenants but never replace the database checks.

## More information

- Takes effect: Phase 0.
- Keycloak is the documented alternative if a client demands self-hosted identity; NHS CIS2 onboarding
  happens when GP Connect is built (Phase 5, ADR-0023).
- How to change: supersede this ADR; the auth adapter interface limits the blast radius.
