---
status: accepted
date: 2026-10-11
decision-makers: Claude Code (lead engineer); Brian may supersede
consulted: master prompt section 20 rule 8; `pnpm licenses list`
informed: everyone working in this repository
---

# Licence allowlist: interpretation and exceptions

## Context and problem statement

Section 20 rule 8 lists the licences a dependency may carry and says anything else is swapped. The
first full install (933 packages) showed SPDX expressions (`MIT OR Apache-2.0`), one licence that is
not listed but is strictly more permissive than one that is (`MIT-0`), and two packages that cannot
be swapped without losing a core tool.

## Decision outcome

`scripts/check-licences.mjs` runs in CI on every pull request and:

- evaluates SPDX expressions: `OR` needs one allowed side, `AND` needs both;
- treats `MIT-0` (MIT without the attribution clause) as allowed, because it grants everything MIT
  grants with fewer conditions;
- allows the Functional Source Licence only for the PowerSync packages named in section 20
  (`@powersync/service-sync-rules`, `@powersync/service-jsonbig`);
- allows these named exceptions, which are never shipped to tenants:
  - `caniuse-lite` (CC-BY-4.0): browser-support data read at build time by browserslist;
  - `spawndamnit` (MIT per its repository; the published package omits the field): a dependency of
    Changesets, a development tool;
  - `parse-cache-control` (BSD-3-Clause per its LICENSE file, whose three clauses it carries; the
    package field says only "BSD"): a dependency of Lighthouse, run by Lighthouse CI, a development
    tool (added 31/10/2026);
- allows these shipped packages whose licence is on the allowlist but whose package field is not an
  SPDX identifier:
  - `xml-escape` (MIT per its LICENSE file; the field says "MIT License"): a dependency of
    `samlify`, through the Better Auth SSO plugin (ADR-0091) (added 31/10/2026).

Any new exception needs a row here and in the script, with the reason.

### Consequences

- Good: the gate is automatic and explains how to fix a failure.
- Neutral: development-only tools are checked too, which is stricter than necessary but simple.
