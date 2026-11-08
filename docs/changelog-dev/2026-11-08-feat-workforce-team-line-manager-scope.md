# Reporting lines widen development scope (ADR-0137, PR 1 of 2)

Branch `feat/workforce-team-line-manager-scope`, from `main` 43c63541. The ADR-0136 follow-up the
lead asked for: a line manager reads their direct reports and a team lead their team.

## What changed

- Migration 0162 (renumbered at merge if needed): `staff_line_manager`, `staff_team` and
  `staff_team_member`, dated and versioned, never deleted, with forced RLS, a tenant policy,
  `touch_mutable`, `capture_version`, `no_delete` and a guard keeping who and when a row is about.
  Only organisation-wide holders of `workforce.staff_file.manage` (HR) write them; HR, the members a
  row is about and development readers in scope read them; earlier versions follow the same rule.
- `app.development_scope_members_for` (0161) is replaced, as its owner, to add a reader's current
  direct reports and the current members of teams they currently lead, when the reader holds one of
  the development permissions in any role in force or access grant. The training matrix, the
  supervisions list, reminder task visibility, development records and revalidation confirmer
  candidates follow.
- API: `GET`/`PUT /v1/workforce/members/{memberId}/line-manager`; `GET`/`POST /v1/workforce/teams`,
  `PUT /v1/workforce/teams/{teamId}`; `GET`/`POST /v1/workforce/teams/{teamId}/members`,
  `PUT .../members/{membershipId}`. HR only for writes (403 `reporting_lines_organisation_wide`,
  audited), `expectedVersion`, audit with opaque ids. OpenAPI and the client regenerated.
- Retention registry, export catalogue, retention.md, records-of-processing and data-standards
  entries. ADR-0137, ADR-0136 linked, H-1643 and H-1644, workforce.md (scope rule, API, screens
  marked "Next: PR 2", known gaps), STATUS and the WORK-009 register row.

## Review round (security and clinical safety)

- Clinical, blocking (HZ-119): reporting lines now widen READS only. 0161's
  `app.development_scope_members_for` is no longer replaced; a new definer,
  `app.development_reach_for` (with `app.development_reach` for the session), adds reporting lines
  for reads: `app.reads_development_of`, the reminder task policy (through
  `app.reaches_staff_permission_for`) and the API lists. Development writes, competence sign-offs and
  withdrawals and revalidation confirmer naming keep the unwidened scope; the training certificate
  update policy moves to `app.reads_development_in_scope_of` before the read helper widens.
  HZ-119 Design and Verification rows; ADR-0137 says reads only; H-1645 for the CSO. The PR now
  needs the `clinical` label.
- Security, low: self-scoped roles never count towards reporting-line reads; the version-history
  rule matches the rows' own read rules (teams included; the member and manager read their own
  line's versions); a concurrent first line is a 409 conflict; the line-manager read matches row-level
  security (a manager reads their own lines).
- Tests: HZ-119 writes refused for a line manager at another home and a team lead (sign-off,
  withdrawal, training, supervision) while reads work; an archived team, a future-dated line, an
  ended lead membership, a non-lead member, a self-scoped role, a non-HR reader of version history;
  API concurrency and a line manager reading their own line.

## Not in this PR

- The screens to keep line managers and teams (PR 2, after this merges).
