# Supervision and appraisal reminder tasks (WORK-009 slice 2)

Branch `feat/workforce-supervision-reminders`, built on slice 1 (`feat/workforce-supervisions-due`,
#214); opened once #214 is on `main`.

## What changed

- Domain: `meetingReminders` and `meetingReminderKey` in `supervision.ts`, with table-driven tests:
  a reminder for each supervision or appraisal due inside `supervision.due_window_days` or overdue,
  once per due date, routine while still to fall due and urgent once overdue, none without a date.
- API: `raiseSupervisionReminders` and `endSupervisionReminders` in `services/development.ts`;
  `remindSupervisionsDue` in `jobs/tasks.ts`, run by the hourly `development-expiry-reminders`
  job. Tasks are kind `workforce.supervision_due`, for HR's role and holders of
  `workforce.supervision.manage`, about no person and no location, with the member's id, the kind
  and the due date only. Recording a supervision or appraisal cancels that kind's open reminders.
- Tests: `apps/api/test/supervision-reminders.test.ts` (the window from the rate table, raised once,
  closed when held and a new one for the next date, nothing for another organisation, nothing for a
  member with no staff role in force).
- Docs: `workforce.md` rule 7, the reminders section and the known gaps; the WORK-009 register row;
  STATUS.

No migration, no new personal data, no web change (the tasks page shows a task's own title).
