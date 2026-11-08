# Supervisions and appraisals due across staff (WORK-009 slice 1)

Branch `feat/workforce-supervisions-due`, from `main`. The workforce spec's known gap: supervision
and appraisal due dates were shown only on each member's training record.

## What changed

- Domain: `meetingsDue` and `meetingsNeedAttention` (`packages/domain/src/workforce/supervision.ts`),
  table-driven tests. With none held the state is `none_recorded`, never a guessed date.
- Rate table: `supervision.due_window_days` (14, Thapsus Care default, to verify; tenant default),
  the window in which a supervision or appraisal shows as due soon. The member's record uses it
  too, so both screens agree; "Due now" now reads "Due soon".
- API: `GET /v1/workforce/supervisions-due`, with the matrix's permissions, member limit and audit
  (`workforce.supervisions_due.viewed`, without names). Filter by location or attention. API tests
  cover the readers, the location filter, attention, another organisation and the audit.
- Web: `/training/supervisions`, linked from the training matrix: each member's next supervision
  and appraisal as an icon and a word with its dates, the last spot check, most urgent first,
  filtered by home and to those needing attention. Journey with axe in light and dark.
- Register: WORK-005, 008, 009 and 012 were `todo` although their code is on `main`; now `partial`
  with their web tests. Counts and STATUS corrected.

No migration and no new personal data. Development records stay organisation-wide for their
readers (migration 0073), so the location filter narrows the list, not the access.
