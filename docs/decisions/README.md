# Architecture decision records

Harbour records every significant or irreversible decision as an ADR in [MADR 4.0](https://adr.github.io/madr/)
format (master prompt section 7). ADR-0001 is the stack, ADR-0002 is tenancy and row-level security,
and ADR-0003 to ADR-0023 record the Appendix (section 22) defaults that the build adopted without waiting
for an answer.

## How to use this folder

- New decision: copy [`template.md`](template.md) to `NNNN-short-title.md` using the next free number,
  fill in every section, set `status` and `date`, and add a row to the index below in the same PR.
- Changing a decision: never edit an accepted decision's outcome in place. Write a new ADR that
  supersedes it, set the old file's status to `superseded by ADR-NNNN`, and keep the old file.
- Brian changes an Appendix default by editing the relevant ADR or telling Claude Code; the build then
  writes the superseding ADR and adapts.
- Where a regulation and the master prompt disagree, the regulation wins and the conflict is recorded
  here (section 3).

## Index

| ADR | Title | Status | Date | Takes effect |
| --- | --- | --- | --- | --- |
| [0001](0001-technology-stack.md) | Technology stack, hosting, residency and disaster recovery | accepted | 2026-10-11 | Phase 0 |
| [0002](0002-tenancy-and-row-level-security.md) | Tenancy and row-level security | accepted | 2026-10-11 | Phase 0 |
| [0003](0003-product-name.md) | Product name: Harbour as the working name | accepted | 2026-10-11 | Phase 0 |
| [0004](0004-first-target-segment.md) | First target segment: residential and nursing homes first | accepted | 2026-10-11 | Phase 0 |
| [0005](0005-design-partner.md) | Design partner: none yet, build against a demo tenant only | accepted | 2026-10-11 | Phase 1 |
| [0006](0006-clinical-safety-officer.md) | Clinical Safety Officer: build the safety artefacts now, CSO signature gates go-live | accepted | 2026-10-11 | Phase 1 gate |
| [0007](0007-data-protection-officer.md) | Data protection lead: Brian as named lead, ICO registration in Phase 0 | accepted | 2026-10-11 | Phase 0 |
| [0008](0008-production-hosting.md) | Production hosting: AWS eu-west-2, with Supabase London permitted for dev and pilots | accepted | 2026-10-11 | Phase 0 |
| [0009](0009-identity-provider.md) | Identity provider: Better Auth, with Keycloak as the documented alternative | accepted | 2026-10-11 | Phase 0 |
| [0010](0010-app-store-distribution.md) | App store distribution: public listing, with a private build as a separate app ID | accepted | 2026-10-11 | Phase 1 |
| [0011](0011-offline-window-and-kiosk-lock.md) | Offline window of 7 days and a 30-second kiosk lock | accepted | 2026-10-11 | Phase 1 |
| [0012](0012-emar-build.md) | eMAR: build it in Phase 2, integrate pharmacy feeds behind an adapter | accepted | 2026-10-11 | Phase 2 |
| [0013](0013-payroll-partner.md) | Payroll partner: Xero Payroll first | accepted | 2026-10-11 | Phase 2 |
| [0014](0014-ai-model-provider.md) | AI model provider: Amazon Bedrock London by default, Claude optional per tenant | accepted | 2026-10-11 | Phase 6 |
| [0015](0015-nhs-dscr-assurance.md) | NHS DSCR assurance: pursue it, collecting evidence from Phase 1 | accepted | 2026-10-11 | Phase 5 |
| [0016](0016-welsh-language.md) | Welsh language: full Welsh UI in Phase 7, i18n ready from Phase 0 | accepted | 2026-10-11 | Phase 7 |
| [0017](0017-childrens-homes.md) | Children's homes: build the Ofsted module in Phase 7 | accepted | 2026-10-11 | Phase 7 |
| [0018](0018-pricing-and-packaging.md) | Pricing and packaging: price list drafted in Phase 3 with the finance module | accepted | 2026-10-11 | Before first sale |
| [0019](0019-open-source-stance.md) | Open source stance: the repository stays private | accepted | 2026-10-11 | Any time |
| [0020](0020-company-set-up.md) | Company set-up items: start in Phase 0 as human actions | accepted | 2026-10-11 | Phase 1 gate |
| [0021](0021-duty-of-candour-timescale.md) | Duty of candour: written notification target is tenant-configurable, 10 working days by default | accepted | 2026-10-11 | Phase 1 |
| [0022](0022-sponsor-licence-module-timing.md) | Sponsor-licence compliance module stays in Phase 2 | accepted | 2026-10-11 | Phase 2 |
| [0023](0023-gp-connect-gating.md) | GP Connect is enabled per tenant only when the tenant holds DSPT "Standards Met" | accepted | 2026-10-11 | Phase 5 |
| [0024](0024-licence-allowlist.md) | Licence allowlist: interpretation and exceptions | accepted | 2026-10-11 | Phase 0 |
| [0025](0025-shared-device-sign-in.md) | Shared and kiosk devices: sign-in factors and the database key | proposed | 2026-10-11 | Phase 1 |
| [0026](0026-design-system-implementation.md) | Design system implementation choices | accepted | 2026-10-11 | Phase 0 |
| [0027](0027-ecm-tolerance-windows.md) | Electronic call monitoring tolerance windows by risk | accepted | 2026-10-11 | Phase 4 |
| [0028](0028-certificate-pinning.md) | Certificate pinning in the mobile app | proposed | 2026-10-11 | Phase 1 |
| [0029](0029-mobile-offline-stack.md) | Mobile offline stack and app identity | accepted | 2026-10-11 | Phase 0 |
| [0030](0030-web-session-and-browser-security.md) | Web sessions, token exposure and the browser security policy | accepted | 2026-10-11 | Phase 0 |
| [0031](0031-document-storage-scanning-and-destruction.md) | Document storage, malware scanning and destruction past retention | accepted | 2026-10-11 | Phase 1 |
| [0032](0032-risk-assessment-rating.md) | Risk assessment ratings: the NPSA matrix on the assessor's judgements, and no falls rating | proposed | 2026-10-11 | Phase 1 |
| [0033](0033-incident-scope.md) | Incident scope: visible through any of its people, and classified with tenant-wide scope | proposed | 2026-10-11 | Phase 1 |
| [0040](0040-transfer-pack-pdf-writer.md) | Hospital transfer pack PDF: a small in-house writer until the document renderer lands | proposed | 2026-10-11 | Phase 1 |
| [0050](0050-evidence-pack-links.md) | Evidence pack links: hashed random tokens bound to one recipient by an emailed code | accepted | 2026-10-11 | Phase 1 |
| [0051](0051-personal-data-in-template-emails.md) | Personal data in template emails: none in subjects, no special category data in bodies | proposed | 2026-10-11 | Phase 1 |
| [0060](0060-family-notification-channels.md) | Family notification channels: provider-neutral ports and events, content-free messages | accepted | 2026-10-11 | Phase 1 |
| [0061](0061-family-portal-scope-and-row-level-security.md) | Family portal scope: portal sessions, no person assignment, and a sharing-decision policy | accepted | 2026-10-11 | Phase 1 (schema step) |
| [0070](0070-search-on-postgres-full-text.md) | Search on Postgres full-text search, under row-level security | accepted | 2026-10-11 | Phase 1 |
| [0071](0071-data-scope-is-per-permission.md) | Data scope is per permission | accepted | 2026-10-12 | Phase 1 |
| [0072](0072-mfa-counts-only-for-the-session-that-used-it.md) | MFA counts only for the session that used it | accepted | 2026-10-16 | Phase 1 |
| [0073](0073-changelog-fragments.md) | Development log entries as one file per pull request (deviation from section 20 rule 9's wording) | accepted | 2026-10-16 | All phases |
| [0074](0074-shift-pattern-on-the-sync-token.md) | The phone learns the shift pattern from its sync token | accepted | 2026-10-13 | Phase 1 |
| [0086](0086-pay-rules-engine.md) | Pay rules engine: pure functions over stored inputs, in whole pence, with their working | accepted | 2026-10-31 | Phase 2 |
| [0087](0087-employment-law-not-yet-in-force.md) | Employment law not yet in force: record, do not calculate | accepted | 2026-10-31 | Phase 2 |
| [0092](0092-import-wizard.md) | Import wizard: staged rows in quarantine, organisation-wide importers, whole-batch commit and undo | proposed | 2026-10-31 | Phase 2 (slice 26) |
| [0090](0090-dsar-workbench-and-disclosure-collector.md) | DSAR workbench and the disclosure collector: one collector over the export catalogue, redaction by a person | accepted | 2026-10-31 | Phase 2 |
| [0082](0082-medicines-rules-at-the-device-boundary.md) | Medicines rules at the medical-device boundary: tags set at transcription and checked, tenant lists as suggestions, no ingredient or allergen matching | proposed | 2026-10-31 | Phase 2 |

## Open items carried by these ADRs

Items Brian may want to confirm (each ADR says how to change it):

- Duty-of-candour written notification timescale (ADR-0021, marked to-verify).
- Whether any first client employs sponsored workers (ADR-0022).
- Whether first clients hold DSPT "Standards Met" (ADR-0023).
- Which councils first clients invoice, so the right portal template is built first (Phase 3; no ADR
  yet, ContrOCC CSV is the default in section 15.3).
- Whether the Bedrock EU geography includes London (ADR-0014).
- Supplier-pays budget versus compressing Phases 3–4 (ADR-0015).
