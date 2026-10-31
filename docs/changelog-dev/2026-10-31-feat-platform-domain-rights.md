# Phase 2 slice 9, data rights, import and single sign-on rules (PLAT-022, PLAT-014, PLAT-005)

Branch `feat/platform-domain-rights`.

## What changed

- Spec: platform.md "Phase 2: data rights, imports and single sign-on" (17 rules that are easy to
  get wrong, and the test list), written before the code.
- Domain, `packages/domain/src/platform/data-rights.ts`: the subject access request clock (starts on
  receipt or on identity information; the corresponding date one month on, the last day of a
  shorter month; each whole day paused for clarification added; a weekend or bank holiday due date
  moved to the next working day; an extension of up to two more months only for a complex request
  or several, decided before the original due date; due soon, overdue and late responses); the
  breach clock (72 hours from awareness, nights and weekends included; a late report needs its
  reasons) with decision support that only suggests a severity and what to consider, and a decision
  recorded only with written reasons, a decider and, against the suggestion, an acknowledgement;
  data protection complaint clocks (30 calendar days to acknowledge, from 19 June 2026; the tenant's
  working-day target alongside; updates at least monthly while open; closure only with an outcome
  that names the right to complain to the ICO); `resolveDataRightsRates`.
- Domain, `imports.ts`: row validation against data-standards.md (NHS number modulus 11, dd/mm/yyyy
  dates that exist and a date of birth not in the future, coded sex, gender, allergy status and
  severity, required fields and lengths, unknown columns, duplicate NHS numbers), errors by row and
  column that never echo a value, a blank allergy status as unknown (HZ-007), the dry run report,
  commit only when every row is valid, and undo once within the window while nothing has changed.
- Domain, `sso.ts`: SSO signs in only an invited or active staff member whose provider-verified
  email matches exactly on a domain the organisation verified and whose every role the
  organisation allows; never a new member, a family member or an operator; an SSO session still
  needs Harbour's own second factor for care records and step-up, and a provider's MFA claim never
  counts.
- Rates (rates.md): `dsar.due_soon_days`, `dp_complaint.acknowledge_target_working_days`,
  `dp_complaint.update_interval_months` and `import.undo_window_days`, Harbour defaults marked
  `to-verify`; the statutory rows (`dsar.*`, `ico.breach.report_hours`,
  `dp_complaint.acknowledge_days`) were already there. No figure is a literal in code.
- Register: PLAT-005, PLAT-014 and PLAT-022 partial (rules). HZ-007: the import rule's test.
- No ADR: the plan assigns ADR-0090 to slice 15, ADR-0091 to slice 33 and ADR-0092 to slice 26.
  No schema, API, web or mobile code; no migration.

## What is next

- Slice 15 (DSAR workbench and breach register), slice 26 (import wizard) and slice 33 (single
  sign-on) build on these rules.

## Human actions logged

- H-610 (DPO): the DSAR clock reading and the four Harbour defaults.
- H-611 (DPO): the breach severity suggestion table.

## Tests

- `packages/domain/src/platform/data-rights.test.ts` (49), `imports.test.ts` (23), `sso.test.ts`
  (19), all table-driven; domain coverage 99.7% lines overall (data-rights.ts 98.5%, imports.ts
  100%, sso.ts 100%).
