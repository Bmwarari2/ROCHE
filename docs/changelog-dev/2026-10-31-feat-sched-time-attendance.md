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
