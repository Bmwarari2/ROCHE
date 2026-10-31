# Recommended answers applied: platform, data protection, retention and scheduling items

Branch `fix/recommended-answers-platform`. The owner decided on 31/10/2026 that every open human
question takes its recommended answer now, reviewed at the testing phase. This applies the answers
whose "Build change" is yes for H-38, H-39, H-106, H-121, H-525, H-566, H-585, H-611, H-612, H-670,
H-700 and H-716.

## What changed

- **Sharing decisions have a maximum length (H-38, HZ-022)**: `checkSharingDecision` refuses a
  decision ending more than `sharing.decision_max_months` (new rate-table row, 12, to verify) after
  it starts, counted on the UK wall clock, or after the end of the authority it rests on
  (`expiry_beyond_maximum`, `expiry_beyond_authority`). The API reads the figure per organisation.
  Decisions recorded before keep their own end date. The lawful basis for sharing under an
  authority or a best-interests decision (Art 6(1)(f) or (e), Art 9(2)(h), Sch 1 para 2) is in the
  records of processing, the DPIA template, people.md and comms.md.
- **Retention classes (H-39, H-106, H-121, H-525, H-670)**, each citing its source and marked
  "verify" where no statute sets the period: `enquiry_not_assessed` (12 months),
  `pre_admission_not_admitted` (3 years), `family_notification_delivery` (12 months), `dp_breach`
  (6 years, also Thapsus breach notices and their acknowledgements), `whistleblowing`,
  `medicines_stock_log`, `medicines_disposal_log`, `temperature_log`, `quality_audit`,
  `staff_survey_response`, `lone_worker_check_in`, `sponsor_record` and `payroll_export`. Data
  protection complaints and the disclosure log map to `data_rights_case`. The export catalogue (which
  the DSAR erasure assessment reads) now carries `dp_breach` and `data_rights_case` for the four
  breach and complaint tables instead of the interim `audit_event`.
- **Search audit events carry their retention class (H-121)**: `scope.retentionClass` from
  `searchAuditRetentionClass`: a search that showed people `audit_event.care_record`, a break-glass
  search or refused break-glass attempt `audit_event`, anything else `security_log` (6 months).
- **Minimum wage (H-585)**: `nmwPayFromGross` no longer counts the flat sleep-in allowance until an
  adviser confirms it does, so the check errs towards flagging an underpayment; scheduling.md
  section 4b records the SSP week split and AWR readings.
- **Breach severity (H-611)**: an identifiable disclosure outside the organisation suggests at least
  medium even for one person with no special category data.
- **Lawful bases (H-612, H-700)**: records of processing B1, the DPIA template section 7A and
  `PROCESSING_PURPOSES` name Art 6(1)(c) under Regulation 17(2)(c) for keeping the care record,
  matching `portabilityApplies`; complaints and compliments have their own purpose, B14, with a
  `complaints` data category (a signed DPIA is flagged for review, as for any new purpose).
- **Free-text dependency category retired (H-716)**: the admission route no longer accepts or writes
  it and the demo seed no longer fills it; `GET /v1/people/{id}/dependency` shows an existing value
  read-only (`admissionFormCategory`) until the first structured category, never prefilled. The
  column stays until a contract migration.
- **Suspend, end and erase the sign-in (H-566)**: `checkMembershipChange` (table-driven) and
  `POST /v1/members/{tenantUserId}/suspend`, `.../end` and `.../sign-in/erase`, each with
  `platform.user.manage`, step-up and the admin sign-out's reach; suspension ends access at once,
  ends the sign-in's sessions unless the person works elsewhere and hurries the device holds;
  ending keeps the member row so care records stay attributable; erasure deletes the auth user
  (email, password hash, passkeys, TOTP secret, sessions, verification tokens) only when no other
  organisation or operator relies on it, unlinks the member row and closes the account deletion
  request. OpenAPI and the typed client regenerated.

## What is next

- H-566: web screens for suspending, ending and erasing (the row stays open), and a restrictive
  row-level policy on `tenant_user` updates as defence in depth (the routes check permission, reach
  and step-up in the API, as the admin sign-out does).
- H-716: drop `placement.dependency_category` in a contract migration once no supported client
  sends it.
- H-525: `lone_worker_check_in` (3 months) differs from the `lone_worker` class (3 years) on
  `feat/sched-lone-worker`; reconcile when that branch merges.
- Every applied answer is reviewed at the testing phase (DPO, CSO, adviser as named).

## Human actions logged

- None new. H-38, H-39, H-106, H-121, H-525, H-585, H-611, H-612, H-670, H-700 and H-716 are
  marked "recommended answer applied 31/10/2026 (review at testing)"; H-566 stays open for its web
  screens.

## Tests

- Domain: `sharing.test.ts` and `sharing-scope.test.ts` (H-38 boundaries, DST, misconfigured
  maximum), `membership.test.ts` (every action from every state), `data-rights.test.ts` (H-611
  rows), `search.test.ts` (retention class per kind of search), `processing-register.test.ts` and
  `dpia.test.ts` (B1 basis, B14), `hours-to-pay.test.ts` (sleep-in, on-call, mileage).
- Database: `reference-data.test.ts` (each new retention class, its trigger and source).
- API: `member-lifecycle.test.ts` (permission, step-up, reach, own membership, order, sessions,
  erasure of every auth table, attribution of a care note after erasure, the deletion request
  closed, another organisation and an operator kept, HZ-006 entries waiting on a device before
  suspension), `people-lifecycle.test.ts` (H-38 maximum;
  H-716 admission drops the field), `dependency.test.ts` (H-716 read-only value), `search.test.ts`
  and `break-glass-search.test.ts` (retention classes).

## Review rounds

- Security review round 1 (the security-reviewer checklist applied to the diff: tenant isolation,
  authorisation, sync, personal data, secrets, validation, dependencies, infra). Fixed: suspension
  no longer ends the sessions of a sign-in that is also a Harbour operator's (it would have signed
  an operator out of the console); the operator lookup uses the same identity-level query by opaque
  id as the operator middleware; erasure also deletes the second-factor records of the sign-in's
  sessions. Accepted and logged: `tenant_user` updates stay enforced in the API (permission, reach,
  step-up), as for the admin sign-out, with a restrictive row-level policy as a follow-up (a job
  with no member updates `tenant_user` today, so the policy needs its own design). No new table,
  synced table, secret or dependency.
