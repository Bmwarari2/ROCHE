# Care Certificate observation and revalidation confirmation permissions (WORK-004, WORK-012)

Branch `fix/workforce-certificate-revalidation-permissions`, PR to follow. Two findings from the
workforce guides' review.

## What changed

- **Care Certificate (rule 20).** Recording "observed competent" now needs only
  `workforce.competence.observe`, the permission meant for observing competence. Before, the only
  screen for it (the induction) needed a staff file permission, so team leaders and clinical leads
  could not reach it.
  - Domain: `mayRecordStandardStep` says who may record each step. The knowledge assessment needs
    `workforce.staff_file.manage` or the observe permission; the observation needs the observe
    permission alone.
  - API: `PUT .../care-certificate/{standardId}` requires the observe permission for the
    observation (403 and audited otherwise). New `GET /v1/workforce/members/{memberId}/care-certificate`
    returns the Care Certificate alone to holders of the staff file read or manage permission or
    the observe permission.
  - Database (migration 0157): the update policy on `care_certificate_progress` now names the
    observe permission alone, as the API does. The new definer `app.care_certificate_profile`
    finds a member's staff file for observers without letting them read it. It is owned by
    `harbour_workforce_definer`.
  - Web: the Care Certificate is a shared component (`CareCertificateSection`). It also shows on
    the training record (`/training/{memberId}`), where observers already go.
- **NMC revalidation (rule 8, separation of duties).** HR no longer ticks the confirmer's
  confirmation.
  - HR names the confirmer with the new `PUT .../revalidation/confirmer`. HR cannot name the nurse
    or themselves, and cannot change the confirmer once the cycle is confirmed.
  - Only the named confirmer, acting for themselves, can record the confirmation, and only after
    HR's review. Anyone else gets 403 `not_the_confirmer`, which is audited.
  - Migration 0156 adds `revalidation_evidence.confirmer_id`, with a check that it is never the
    worker. Migration 0157 extends `app.revalidation_guard` to enforce the rule in the database.
  - The planner's HR form no longer has a confirmation checkbox. HR is offered "Name the
    confirmer". Only the named confirmer is offered "Record your confirmation", with a date and a
    confirmation box. The plan shows who is to confirm, or who confirmed and when.
  - Existing confirmations are kept as recorded.
- The roles and the permission catalogue are unchanged. Docs updated: `workforce.md` (section 3
  table, sections 2b and 2e, rules 8 and 20, routes, screens), `data-standards.md`,
  `records-of-processing.md` and the export catalogue (`confirmer_id`).

## Review round: accessibility and security (07/11/2026)

- Accessibility: a Care Certificate step on the training record is now announced and focused on
  arrival. `DevelopmentArrival` accepts the Care Certificate's keys through
  `developmentArrivalKey`, which is unit-tested. The confirmation's tick box is also checked on the
  server ("Tick the box to confirm"). When nobody can be named confirmer, the page says so in a
  sentence instead of showing an empty list.
- Security, advisory a: review and confirmation are separate duties. Whoever reviewed a cycle is
  never named its confirmer (422 `names_reviewer`), the named confirmer never reviews it (403
  `confirmer_reviews`), and the reviewer never confirms (403 `reviewer_confirms`). The database
  guard refuses `confirmer_id = reviewed_by`.
- Security, advisory b: only a member holding `workforce.training.manage` or
  `workforce.supervision.manage` can be named confirmer (422 `confirmer_not_permitted`, audited).
  This is counted by the definer `app.member_may_confirm_revalidation`, which also counts HR's
  roles with no person scope.
- The picker now comes from the new `GET .../revalidation/confirmers`, through the definer
  `app.revalidation_confirmer_candidates`. It leaves out the nurse, the caller and the reviewer.
  The earlier widening of `GET /v1/workforce/colleagues` is withdrawn.
- These changes are in migration 0157, which is not yet merged and is edited in place. Database,
  API and domain tests cover each rule.
- New Playwright journeys in `apps/web/e2e/training.spec.ts`:
  - "a clinical lead without the staff file records a Care Certificate observation". The demo
    seed has no team leader. The demo nurse, a clinical lead, holds the observe permission and no
    staff file permission.
  - "HR names the revalidation confirmer; only the named confirmer records the confirmation".
  - `apps/web/e2e/workforce.spec.ts`: the induction test now also checks the Care Certificate.

## What is next

- Run the e2e specs that cover these screens: `apps/web/e2e/workforce.spec.ts`, plus the
  training record specs.
- The PUT revalidation and review routes threw the own-record refusal outside the audited
  transaction, so it answered 500 and was not audited. Both now refuse HR's own record inside the
  transaction with an audited 403, as the confirmation route does, with an API test for each.
