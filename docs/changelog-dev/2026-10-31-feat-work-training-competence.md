# Training, competence, supervision and the competence port (Phase 2 slice 17)

Branch `feat/work-training-competence`, stacked on `feat/work-staff-profile` (slice 11). Register
rows WORK-005, WORK-008, WORK-009 and WORK-012 (schema and API; screens come with slice 57).

## What changed

- Spec: [workforce.md](../specs/workforce.md) section 2b (six tables), section 3 (who reads and
  writes; no new permission), section 5 (ten routes, the competence port, reminders and task
  visibility), section 7 (HZ-119 and HZ-124 controls), section 9 (tests) and section 11 (gaps).
  [ADR-0085](../decisions/0085-competence-gating.md) written from the phase plan's default.
- Domain: `competenceDecision` (the port's rule: allowed through the valid-until day, blocked as
  `missing`, `expired` or `withdrawn`), the competence catalogue with medicines competences on
  `competence.medicines.refresh_months` and the rest on a new `competence.default_refresh_months`
  (a Harbour default to verify, H-690), and `competenceValidUntil`.
- Database: migration 0079 (`training_requirement`, `training_record`, `competence_sign_off`,
  `competence_withdrawal`, `supervision_record`, `revalidation_evidence`), keyed by the member, with
  forced row-level security. Read organisation-wide by holders of the workforce read permissions
  and by the member for their own; never written by the member about themselves. Sign-offs and
  withdrawals are append-only; a sign-off is observed in the observer's own name by a holder of
  `workforce.competence.observe`, never for oneself and never dated in the future (HZ-119).
- Task visibility (closing slice 11's gap): a task about no person and no location whose required
  permission is a workforce one is visible to holders of that permission (`app.task_visible_with`
  replaces the task scope policies), so HR's role sees its reminders; without MFA a session does
  not list staff file tasks.
- API: the training matrix by role, a member's development record (matrix with Oliver McGowan
  tiers, records, competences, supervisions with the next supervision and appraisal, revalidation
  plan), recording and correcting training, signing off and withdrawing competence (publishing
  `workforce.competence.changed` on the outbox), supervisions, revalidation evidence and
  `/v1/me/development`. The competence port `competencePort` for medicines and scheduling on the
  server. A shared `withSystemRights` helper for the port and for ending reminder tasks. OpenAPI and
  the client regenerated.
- Reminders: the `development-expiry-reminders` job (hourly) raises one task for HR per reminder
  day before a required topic's or a competence's valid-until date.
- Hazards and boundary: HZ-124 gains two controls and three verification rows; the rows for HZ-119
  (being written by slice 3) are in workforce.md section 7, ready to move into that entry. The
  medical-device boundary re-checked and noted.
- Data protection: records of processing, data standards, retention, the export catalogue.

## What is next

- Slice 22 calls `competencePort` for medicines administration; slices 21 and 27 for rostering.
- Slice 57: the screens, supervision reminders, and self-service revalidation (H-693).
- `packages/contracts/src/client/api-types.ts` is now just over Biome's 1 MiB limit, so Biome
  skips it with a warning; raising `files.maxSize` or ignoring the generated file is the lead's
  call.

## Human actions logged

- H-690 (competence catalogue and default refresh), H-691 (CSO review of ADR-0085 and the review
  decisions), H-692 (supervision notes), H-693 (who records revalidation evidence), H-694 (how far
  observers read).

## Tests

- `packages/domain/src/workforce/competence-port.test.ts`: 20 tests.
- `packages/db/test/training-competence.test.ts`: 20 tests.
- `apps/api/test/training-competence.test.ts`: 20 tests; `routing-roles.test.ts` checks the
  reminder roles hold their permissions.

## Review rounds

- Round 1 (clinical safety and security reviews):
  - A withdrawal now blocks the competence as a whole until a new observation on or after it (was
    one sign-off only), and the database refuses a sign-off dated before a withdrawal.
  - The server's time decides the port; a device's time can only block (`competenceDecisionAt`).
  - The database fixes each sign-off's valid-until to the rate table; sign-offs use the member's
    nation; the HZ-124 log no longer points the rota at `competenceGate` (marked deprecated for
    gating).
  - Reminders are cancelled by a renewal and skip leavers; HZ-124 tests named.
  - The development record asks the database whether the caller may read the member before
    anything is read with system rights, and no longer infers the start date from the staff file;
    earlier versions of development records follow their read rule; staff file reminders need MFA
    to open, assign or complete, not only to list; `workforce.self.read` tasks are never widened;
    a supervision is changed only by whoever held it; the own-record view is audited.
  - Fixed a guard defect the new tests found: correcting a training record failed because the
    update guard read a supervision column on every table.
  - Left as gaps (workforce.md section 11): reminders for missing items; definer functions in
    place of `withSystemRights`; how far observers read (H-694).
