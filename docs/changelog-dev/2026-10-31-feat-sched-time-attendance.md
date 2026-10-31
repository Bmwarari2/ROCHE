# Time and attendance and working-time records (SCHED-004, SCHED-003, Phase 2 slice 30)

Branch `feat/sched-time-attendance`, cut from `feat/sched-bank-agency`. Rules, schema, migration and
API. The screens are slice 60 and the phone's offline queue is slice 71.

## What changed

- **Spec**: `docs/specs/scheduling.md` section 16, written first.
- **Domain** (`packages/domain/src/scheduling/time-attendance.ts`):
  - clock flags, `clockFlags` (HZ-010);
  - pairing a shift's events, `pairClockEvents`;
  - approval never by the worker, `approvalProblem`;
  - corrections that supersede, `currentApproved`;
  - approved time as working time, `timesheetWorkPeriods`;
  - opt-outs on file, `optOutAgreement`;
  - the booked window, `withinBookedWindow`.
- **Migration** `0109_time_attendance.sql`, with forced row-level security throughout:
  - tables `clock_setting`, `clock_event` (append-only, client UUID), `timesheet_entry`,
    `sleep_in_awake_period` (append-only), `working_time_opt_out` and `working_time_result`
    (append-only);
  - guards: an approved entry is never changed, approval is only in the approver's own name and
    never by the worker, and a correction is of an approved entry, one at a time.
- **API** (`apps/api/src/routes/time-attendance.ts`, `apps/api/src/services/time-attendance.ts`):
  - your own clock events, idempotent; a bank or agency member's late upload is accepted inside the
    booked window and flagged;
  - the rule on the day at clock-in (H-920): refused online, flagged with an urgent task when late;
    bank and agency workers need an induction at the location;
  - a clock-out drafts a timesheet with its breaks;
  - manual entries, changes to drafts, approval with a stored working time result (advice; a task
    when findings stand), corrections, awake periods, exceptions, opt-outs, stored results;
  - clock evidence only once the DPIA is approved.
- **Hazards**: HZ-010, HZ-011 and HZ-124 gain controls and tests.
- **Data protection** (employee monitoring): records of processing, data standards, retention and
  the export catalogue (six tables).
- **Human actions**: H-990 to H-999.

## Review fixes

The security and clinical-safety reviews were run and their findings fixed:

- **Rule on the day:**
  - A blocked clock-in is refused while its shift has not ended, whatever the device's time
    (`clockInRefused`), and the person in charge gets a task.
  - A clock-in names its shift.
  - The induction counts by the shift's date.
- **Late uploads:** kept, flagged and raised when the shift, booking or permission was removed after
  the time was worked; every refusal is audited.
- **Evidence:** kept only as the location's setting asks; NFC tags and device ids are short codes
  (database checks).
- **Clock events:** written in the member's own name; replays race safely.
- **Pairing:** a clock-in or clock-out is in one entry at most (unique index, foreign keys), and a
  clock-in uploaded after its clock-out pairs with it.
- **Approval:** never by whoever entered or last changed the entry, and never before it ends.
- **Tasks:** clock exception tasks are deduplicated and titled by the check; working time tasks are
  one per worker.
- **Opt-outs and results:** limited to approvers where the member works; results are written only
  by the system.
- **Database:** definer and ACL fixes, and a cross-tenant test over all six tables.
- **Tests:** DST tests across both clock changes.

## Merged forward: bank and agency recommended answers (31 October 2026)

`feat/sched-bank-agency` (H-921, H-924, H-927) is merged in. A bank or agency member's late clock
event is now accepted only within the upload grace period (`access.agency.upload_grace_hours`)
after their window closes. After that it is refused with `upload_grace_ended` and the refusal is
audited. This closes the open part of the slice 30 security review (H-993). Snapshot 0109 is
rechained to include `agency_awr_record`.


## Merged origin/main (through feat/sched-bank-agency)

Main (migrations 0000 to 0103) is merged in through the bank and agency branch. Snapshot 0109 is
rechained onto 0104's merged state, and duplicate export catalogue entries for the rota tables
(now on main) are removed. The timesheet, opt-out and record-version read policies now name the
organisation's own read (`app.is_system()`) outright, for main's DSAR collector check. Their effect
is unchanged, because the helper functions already passed it.
