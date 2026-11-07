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
  - Database (migration 0154): the update policy on `care_certificate_progress` now names the
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
  - Migration 0153 adds `revalidation_evidence.confirmer_id`, with a check that it is never the
    worker. Migration 0154 extends `app.revalidation_guard` to enforce the rule in the database.
  - The planner's HR form no longer has a confirmation checkbox. HR is offered "Name the
    confirmer". Only the named confirmer is offered "Record your confirmation", with a date and a
    confirmation box. The plan shows who is to confirm, or who confirmed and when.
  - Existing confirmations are kept as recorded.
- `GET /v1/workforce/colleagues` also admits `workforce.training.manage`, so HR can choose the
  confirmer. It returns names and job titles only.
- The roles and the permission catalogue are unchanged. Docs updated: `workforce.md` (section 3
  table, sections 2b and 2e, rules 8 and 20, routes, screens), `data-standards.md`,
  `records-of-processing.md` and the export catalogue (`confirmer_id`).

## What is next

- Run the e2e specs that cover these screens: `apps/web/e2e/workforce.spec.ts`, plus the
  training record specs.
- The PUT revalidation and review routes threw the own-record refusal outside the audited
  transaction, so it answered 500 and was not audited. Both now refuse HR's own record inside the
  transaction with an audited 403, as the confirmation route does, with an API test for each.
