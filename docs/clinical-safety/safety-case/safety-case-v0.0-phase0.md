# Clinical safety case report v0.0: Phase 0 foundations

| Item | Value |
| --- | --- |
| Product | Harbour |
| Manufacturer | Thapsus Cargo Ltd |
| Release | Phase 0 foundations, platform version `v0.0.x` `[release tag and commit - filled at tagging]` |
| Report status | **Draft**. Not signed. Not for use with a live tenant |
| Prepared by | Harbour engineering (Claude Code under the lead engineer), 11 October 2026 |
| Clinical Safety Officer | `[CSO name - human action]` |
| Standard | [DCB0129](https://adultsocialcare.standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-manufacture-of-health-it-systems) |

## 1. Purpose

This is the first clinical safety case report for Harbour. It covers the Phase 0 foundations release, which contains **no clinical functionality**: no care plans, notes, charts, assessments, medicines, incidents or notifications. Its purpose is to establish the clinical risk management file, open the hazard log with the day-one hazards, and record which safety-relevant foundations exist, so that later reports can show the safety argument growing release by release.

## 2. System description and intended use

Harbour is a multi-tenant digital social care record and operational platform for UK adult social care providers. The intended use is set out in [the clinical risk management plan](../clinical-risk-management-plan.md), section 1.3, and the medical-device boundary in [medical-device-boundary.md](../../compliance/medical-device-boundary.md).

**What the Phase 0 release contains** (per master prompt section 19, Phase 0 scope):

| Component | Phase 0 content | Clinical relevance |
| --- | --- | --- |
| Tenancy | Tenants, groups, locations; `tenant_id` on every row; Postgres RLS with `FORCE ROW LEVEL SECURITY`; non-owner application role | Foundation control for HZ-011 |
| Authentication and roles | Passkeys and TOTP, built-in roles and permissions | Foundation for scoping (HZ-011) |
| Audit | Append-only `audit_event` table | Foundation for attributable records |
| People (demographics) | Person record with photo, demographics, contacts, allergies and communication needs; seeded demo tenant with invented people | Foundation control for HZ-001 and HZ-007 |
| Mobile skeleton | Sign-in, assigned people list offline, point-of-care header, SQLCipher store, biometric lock, sync status banner | Foundation controls for HZ-001, HZ-002, HZ-006, HZ-007, HZ-010 |
| Notification centre | In-app, push, email, SMS with escalation chains | Foundation for HZ-003, HZ-008, HZ-013 |
| Forms engine skeleton, rate table | No validated tools yet | None until Phase 1 |
| Web shell, design system | Sign-in, tenant and location switcher, empty dashboards; status by icon plus word | Accessibility foundation |

**Not in this release**: every clinical workflow. The release is for `dev` and `staging` with demo data only.

## 3. Clinical safety claim

> The Phase 0 foundations release introduces no function that a care worker, nurse or manager can use to make or record a care decision. It therefore cannot directly cause clinical harm. The release puts in place direct controls for six of the thirteen day-one hazards (HZ-001, HZ-002, HZ-006, HZ-007, HZ-010, HZ-011) and foundations for five more (HZ-003, HZ-004, HZ-008, HZ-009, HZ-013), which later releases build on.

The claim holds only while the release is used with demo data in `dev` and `staging`. It does **not** support use with real people.

## 4. Argument and evidence

| Argument | Evidence |
| --- | --- |
| A1. Clinical risk management is established | [Clinical risk management plan](../clinical-risk-management-plan.md) (draft); [hazard log](../hazard-log.md) opened; CODEOWNERS routes `docs/clinical-safety` to a required reviewer; PR template asks for clinical-safety impact; CI docs gate fails a `clinical` PR that leaves the hazard log or spec untouched |
| A2. The day-one hazards are identified and assessed | Hazard log HZ-001 to HZ-013, all `open`, with initial and target residual ratings proposed by engineering |
| A3. No clinical functionality is present | Feature register ([feature-register.md](../../specs/feature-register.md)) shows no clinical feature `done`; the release contains no care, medicines or safety module code beyond schema and skeletons `[engineering to confirm at tagging]` |
| A4. Foundation controls are built and tested | See section 5 |
| A5. Tenant isolation is proven | Phase 0 gate: cross-tenant isolation tests pass through the database, the API and the sync streams (HZ-011) `[CI run link - filled at tagging]` |
| A6. The medical-device boundary is recorded | [medical-device-boundary.md](../../compliance/medical-device-boundary.md) |

## 5. Hazards and foundation controls in this release

| Hazard | Foundation control in Phase 0 | Status |
| --- | --- | --- |
| HZ-001 Wrong-person record selection | Point-of-care header with photo, name, date of birth, room, allergies and communication needs | Open |
| HZ-002 Stale offline data shown as current | Sync status banner with last-sync time; stale-data warning; never-evict reference data | Open |
| HZ-003 Missed medication administration | Notification centre escalation chains (no medicines yet) | Open |
| HZ-004 Duplicated medication administration | Append-only event pattern with client UUIDs (no medicines yet) | Open |
| HZ-005 Unit or dose transcription error | None (Phase 2) | Open |
| HZ-006 Silent sync failure | Sync status banner with last-sync time and queued changes; stale-data warning | Open |
| HZ-007 Incorrect or missing allergy display | Allergies in the header; allergies never evicted offline | Open |
| HZ-008 Alert fatigue | Notification centre; status by icon and word | Open |
| HZ-009 Time-zone and daylight-saving errors | UTC with local offset; date-only fields as dates | Open |
| HZ-010 Device clock drift | Server-received time recorded alongside device time | Open |
| HZ-011 Cross-tenant or out-of-scope exposure | RLS with FORCE, non-owner role, `app.tenant_id` per transaction, isolation tests | Open |
| HZ-012 Validated tool calculated incorrectly | None (Phase 1) | Open |
| HZ-013 Statutory notification missed or late | Notification centre (no incidents yet) | Open |

**Hazards opened in this release**: HZ-001 to HZ-013. **Changed**: none. **Closed**: none.

**Verification evidence**: `[CI run link and hazard-ID test report - filled at tagging]`. The Phase 0 gate tests are the HZ-011 isolation tests. Every other hazard's verification is planned for Phase 1 or Phase 2, as the hazard log states; the Phase 1 gate requires every hazard to have at least one test.

## 6. Residual risk

No residual risk arises from clinical use because there is none. All thirteen hazards remain open with target residual ratings that the CSO has not yet reviewed. Five hazards are proposed to settle at level 3 (HZ-002, HZ-003, HZ-005, HZ-008, HZ-013); the justifications are in the hazard log for CSO decision.

## 7. Deployer information

No tenant may deploy this release for real people. There are no deployer controls for this release. The [DCB0160 deployment template](../dcb0160-deployment-template.md) is published for information so that design-partner providers can prepare.

## 8. Known limitations

- The hazard log ratings are engineering proposals; no CSO has reviewed them.
- No SWIFT workshop has yet been held; hazard identification so far is from the master specification.
- The hazard log is in Markdown; the export in the NHS assurance format arrives in Phase 5.

## 9. Sign-off

| Role | Name | Registration | Date | Signature |
| --- | --- | --- | --- | --- |
| Clinical Safety Officer | `[CSO name - human action]` | `[professional body and number - human action]` | `[date]` | `[signature - human action]` |
| Top management | `[Brian, Thapsus director - human action]` | Not applicable | `[date]` | `[signature - human action]` |

Signature of this report is logged in [docs/plans/human-actions.md](../../plans/human-actions.md). It is not a precondition for continuing the build; it is a precondition for any later report being relied on for a live tenant, because the v0.1 report builds on this one.
