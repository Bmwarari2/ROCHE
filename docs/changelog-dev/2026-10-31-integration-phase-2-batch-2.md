# Phase 2 batch 2: integration fixes

Branch `integration/phase-2-batch-2`: main plus, in order, `feat/web-data-rights`,
`feat/work-training-competence`, `feat/quality-audit-programme`, `feat/web-quality-framework-audits`,
`feat/sched-rota-builder`, `feat/work-applicant-tracking`, `feat/safety-speak-up`,
`feat/web-safety-silos`, `feat/work-casework`, `feat/work-onboarding-leavers`,
`feat/safety-outbreaks-ipc`, `feat/quality-data-security-evidence`, `feat/platform-sso`,
`feat/work-sponsor-licence`, `feat/safety-deaths-missing`, `feat/safety-disclosure-requests` and
`feat/web-import-wizard`, then main again (#135 and #160).

## What changed

- Data rights: the DSAR record and bundle read only the exported columns (ab9c3916), so a staff
  member's request no longer fails on the invitation table's column grants.
- Migration journal: main's 0000 to 0088 and the batch's 0079, 0081, 0083, 0085, 0086, 0091, 0093,
  0094, 0095, 0097, 0099, 0101 and 0103, once each and sorted. `when` is respaced from 0076 onward so
  it rises with idx (a one-off: no persistent database has applied 0076 to 0088). No file was
  renamed or renumbered.
- Sample data removal (HZ-072): `app.sample_removal_tables()` is redefined whole by 0074, 0075, 0093
  and 0099. 0099, the last, now also lists `dependency_assessment`, `safeguarding_concern` and
  `outbreak_case`, with their `harbour_sample_owner` grants beside it. The sample-data test blocks
  removal for complaints, compliments, DSAR cases, disclosure requests, outbreaks, data security
  evidence and certificates, policy versions, downtime packs, escalation links and outages.
- Silos: `SILO_PERMISSIONS` holds both `safety.speak_up.manage` (0086) and
  `workforce.casework.manage` (0101); each migration keeps its own guards. The silo tests check
  each silo's own role, and the record-version check exempts both silos' tables.
- Shared lists kept whole: worker jobs (policy reminders, training expiry, leavers' access, data
  security renewals, Herbert reviews, candour), the export catalogue, permissions and the generated
  permission matrix, the processing register (B15, B16), definer ACLs, the no-login roles
  (`harbour_import_owner`, `harbour_silo_owner`), route mounting, task details and the storage key
  pattern (DSAR bundles under `dsar/`, disclosure packs under `tenants/`).
- The seed has 23 built-in roles. The API typecheck runs with a 4 GiB heap: with single sign-on
  merged, tsc needs just over Node's default. `apps/web/AGENTS.md`, committed by accident, is gone.
- Hazard log: HZ-124's controls and verification, which an earlier merge had moved into HZ-126, are
  back in HZ-124; the residual-risk paragraph in the summary is one paragraph (sixteen hazards).
- Specs: the human actions page, data standards (dependency tool and policy library tables were
  missing headers) and the register summary counts are repaired.
- The OpenAPI document and typed client are regenerated.

## What is next

- Open the pull request; merge once CI is green.
- Disclosure packs are stored under `tenants/` in the exports bucket, which expires after 30 days;
  DSAR bundles moved to `dsar/` for that reason (#149). Decide where packs are kept.
- Spec section numbers repeat in quality.md (18), workforce.md (2b) and safety.md (11); renumber
  them with their cross-references in a docs pull request.
- Chores still open: the snapshot chain (several snapshots share or skip a `prevId`), one
  `app.silo_permissions()` for both silos, and tables without header rows left in the hazard log
  (HZ-015, HZ-027, HZ-073, HZ-091) and data standards (breach register, import wizard) on main.

## Human actions logged

- None.

## Tests

- Biome (`biome ci .`), typecheck (10 tasks), the contract diff after regenerating, Markdown links
  and licences: clean.
- Domain 6,277 passed (coverage 99.7% of lines); web 1,773; API 1,792; database 1,043 (Postgres
  16 locally; CI runs 17); sync 83; mobile 1,165; UI 350; native UI 141; i18n 48; contracts 34.
