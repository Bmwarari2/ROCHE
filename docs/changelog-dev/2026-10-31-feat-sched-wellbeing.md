# 31 October 2026: staff wellbeing and voice (slice 44; SCHED-011)

Branch `feat/sched-wellbeing`; migration 0115; human actions H-1080 to H-1084.

## What changed

- Spec: [scheduling.md](../specs/scheduling.md) section 16 covers pulse surveys, anonymous
  responses, the minimum group size, recognition and wellbeing check-ins, with its permissions,
  API, audit and test list.
- Domain: `packages/domain/src/scheduling/wellbeing` holds the table-driven rules:
  - survey definitions and moves;
  - response checks;
  - the UK week a response keeps;
  - the minimum group size, which an organisation can raise and never lower;
  - when results may show;
  - recognition and check-in checks.
- Database (0115): five tables, all with forced RLS.
  - `pulse_survey_response` has no member, no creator and no time but the UK week, and a random
    id. The application role has no grant on it and a restrictive deny policy.
  - Two definer functions reach responses. `app.submit_pulse_response` answers once, for a member
    the survey asks. `app.pulse_survey_results` shows results only once the survey has closed and
    at the size, each question likewise, with no count below the size and free text in
    alphabetical order.
  - `app.works_at` and `app.holds_own_permission` support those checks.
  - Guards and append-only triggers.
  - Existing tenants' built-in roles gain the two new permissions, audited.
- Permissions: `scheduling.wellbeing.manage` (owner, Registered Manager, deputy) and
  `scheduling.wellbeing.self` (every staff role with `scheduling.timesheet.self`).
- API: `/v1/pulse-surveys` (list, write, change a draft, open, close, answer with 204, results),
  `/v1/recognition` and `/v1/wellbeing-check-ins` (record, list, share or stop sharing).
  - A response is audited with an anonymous actor, naming the survey only.
  - Other audit events carry ids only.
- Rate `wellbeing.survey_min_group_size` (5, to verify) and retention class `staff_wellbeing`
  (2 years, to verify).
- The export catalogue leaves anonymous responses out.
- Updated: records of processing (B3), data standards, and DPIA R28 (measures and residual risk).

## Security review

- Responses wait apart and move, shuffled, when the survey closes, so a response never shares a
  transaction with its participation row.
- Each response is audited anonymously at the close, never as it arrives.
- Only members on a staff file from before the survey opened answer, never its writer or the
  home's survey managers.
- A scale count below the size is hidden, with the next smallest when only one would be
  (`suppressCounts`).
- The definer functions are owned by the NOLOGIN role `harbour_wellbeing_owner`.
- The export holds only shared check-ins.
- Participation rows have a random id.
- Recognition refusals say nothing about where a colleague works.
- Left open, in H-1081: comparing overlapping surveys, and the window before a survey closes.

## Not built

- Screens, exit interviews, turnover by team and the speak-up link (H-1083).
- The organisation's own support wording (H-1084).
- The retention job (H-1082).
