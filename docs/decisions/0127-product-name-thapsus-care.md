---
status: "accepted"
date: 2026-11-07
decision-makers: Brian (owner, the rename, R1); the lead engineering session (keeping identifiers)
consulted: engineering (Claude Code sessions)
informed: clinical safety officer (when appointed, H-20), data protection lead
---

# The product is called Thapsus Care; "Harbour" stays only in technical identifiers

## Context and problem statement

"Harbour" has been the working codename since the master prompt (section 1: "a working codename.
Search-and-replace it with the final product name before the first external release"; Appendix
open item "Product name and domain"). The owner has chosen **Thapsus Care**, built by Thapsus Cargo
Ltd. The name appears in about 2,800 places people read: the web and mobile apps' words (the en-GB
and Welsh catalogues), the mobile app's display name and permission prompts, sign-in (the
authenticator issuer and passkey display name), email and PDF text, the API's messages, the user
guides, the safety case, the hazard log and the records of processing. It also appears in many
technical identifiers that no person reads. The rename must not break sign-in, sync, deployments or
data, and must land in one pass so that no screen says both names.

## Decision drivers

- People see one name everywhere: apps, emails, PDFs, guides, the safety case and the DPIA.
- Nothing that works today breaks: passkeys, sessions, sync, the mobile app's identity in the
  stores, cloud resources, database roles and the API's headers.
- The rename is mechanical, repeatable and checked, and lands between merge batches so that open
  branches do not conflict with it.

## Considered options

1. Rename everything, identifiers included (`@harbour/*`, `HARBOUR_*`, `harbour_*` roles, cloud
   resources, bundle ids).
2. Rename what people read; keep technical identifiers (chosen).
3. Keep "Harbour" as the product name.

## Decision outcome

Option 2. "Thapsus Care" replaces "Harbour" wherever a person reads it, in one scripted pass
(`scripts/rename-product.mjs`) after merge batch 4, by the plan in
[rename-thapsus-care.md](../plans/rename-thapsus-care.md). Technical identifiers keep the codename:

- packages `@harbour/*`, environment variables `HARBOUR_*`, database roles and schemas
  (`harbour_app`, `harbour_owner` and the rest), the tenant header `x-harbour-tenant`, the deep link
  scheme `harbour`, the Expo slug, the iOS and Android bundle ids, cloud project and resource names,
  Terraform modules and state, container images and the PowerSync instance;
- the passkey relying party id (`PASSKEY_RP_ID`, a domain): changing it would orphan every passkey;
- code comments, migrations already on `main`, and frozen history (accepted ADRs, the changelog
  fragments and `CHANGELOG-DEV.md`), which record what was true when written.

Sign-in display names change for new enrolments only: the authenticator issuer and the passkey's
display name read "Thapsus Care" from the release; existing authenticator entries keep their old
label until re-enrolled, and existing passkeys keep working because the relying party id does not
change. Stored rows that carry the old name (for example `audit_starter_template.source` and
rate-table sources seeded from `rates.md`) change by a forward data migration in the same release.

The invented demo and fixture names ("Harbour House", "Harbour Lodge", "Harbour Demo Care" and the
rest) are fictional places and organisations, not the product, and stay (decided 07/11/2026):
renaming them would churn the end-to-end selectors for no user benefit.

### Consequences

- Good: one name for users, inspectors and families; no breakage of identity, sync or
  infrastructure; a diff that is mostly words and is checked by `--check` in CI.
- Bad: the codebase and infrastructure keep a codename people may notice in URLs of developer
  tools, logs and package names; recorded here so nobody renames them by accident.
- The trade mark search and app store name checks (H-1511), the domain and email sender name
  (H-1512), and the listings, privacy notice, DPIA wording and pilot notice (H-1513) are human
  actions.

### Confirmation

`node scripts/rename-product.mjs --check` passes in CI after the rename; the full test suites, the
Playwright journeys with axe and the Maestro flows pass; the plan's manual checks are done.
