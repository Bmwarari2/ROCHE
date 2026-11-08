---
status: "proposed"
date: 2026-11-08
decision-makers: lead engineer (Claude Code lead session), for the owner
consulted: security reviewer and clinical safety reviewer (agents); owner to confirm (H-1643); CSO to confirm (H-1645)
informed: engineering
---

# Reporting lines widen development scope

Amends [ADR-0136](0136-development-reads-follow-attribute-scope.md).

## Context and problem statement

ADR-0136 made development records (training, competence, supervision, revalidation, e-learning,
certificates), the training matrix, the supervisions and appraisals due list and the reminder tasks
about a member follow attribute scope: organisation-wide holders read everyone, a holder at a home
reads the members who work there, and a member reads their own. It recorded a gap: the constraints
digest (section 4) also names team and assigned people, and staff have neither a team nor a line
manager in the schema, so a senior carer who line manages two people, or a night team's lead, can
only be given a whole home. The lead asked on 08/11/2026 for the least-privilege rule: a line
manager sees their direct reports, a team lead sees their team.

## Decision drivers

- Least privilege (master prompt sections 4 and 5.3), enforced in the API and again in row-level
  security, with one rule for records, lists and reminder tasks.
- Reporting lines change over time and who managed whom on a day must be answerable (history kept).
- Reporting lines are HR data: who maintains them must be as narrow as who maintains the staff file.

## Considered options

1. A line manager field on the staff profile, overwritten on change.
2. Effective-dated reporting lines (`staff_line_manager`) and staff teams with dated memberships and
   leads (`staff_team`, `staff_team_member`), versioned and never deleted.
3. A new role scope kind `team`, with team membership as a role attribute.

## Decision outcome

Chosen option 2 (provisional; the owner confirms under H-1643):

- **Who maintains them**: organisation-wide holders of `workforce.staff_file.manage` (HR's role, the
  owner). A home's manager is refused in words (403 `reporting_lines_organisation_wide`), audited;
  row-level security holds the same. Never oneself as line manager; both must be current members of
  staff in the same organisation; one current line per member and one current membership per team.
  Every change keeps a version and is audited with opaque ids.
- **Reads only** (clinical review, HZ-119): reporting lines widen what a member may read, never what
  they may write. Development writes (training records, supervisions, revalidation evidence,
  certificates, competence sign-offs and withdrawals) and revalidation confirmer naming keep
  ADR-0136's scope (`app.development_scope_members_for`, unchanged); reads use
  `app.development_reach_for`, which adds reporting lines to it. A line manager at one home never
  signs off or withdraws a report's competence at another home. The CSO confirms under H-1645.
- **What a relationship does**: a line manager's current direct reports, and the current members of
  teams a member currently leads (not archived), are added to the members whose development records,
  lists and reminder tasks that member's development permissions let them read
  (`app.development_reach_for`, migration 0162). The relationship **grants
  no permission by itself**: a line manager or team lead who holds no development permission reads
  nothing more; one who holds it in a tenant, location, no-person or assigned role in force (a
  senior carer's assigned role included; never a self-scoped role), or an access grant, reads their
  reports or team, wherever those members work. Scopes combine as a
  union with ADR-0136's organisation-wide and home scopes. Ended lines and memberships give nothing.
- **Who reads the lines**: HR, the members a row is about (the member and their manager), and
  holders of a development read permission whose scope covers the member. Team names and homes are
  not about a person and are readable by anyone who reads development records somewhere.
- **Retention**: as the staff file of the member a row is about (`staff_file`); teams are
  organisation configuration.

Option 1 loses history and cannot answer who managed whom on a day. Option 3 would make reporting
lines part of role assignment, which is maintained by platform administrators rather than HR, and
would let a team grant permissions, against the least-privilege default.

### Consequences

- Good: the training matrix, the supervisions list, the reminder tasks, the development record and
  revalidation confirmer candidates all follow, because they ask the same definer.
- Good: competence gating at the point of care is unchanged: the competence port reads every
  worker as the system (ADR-0085), so no reporting line can hide a withdrawn competence.
- Neutral: the screens to maintain line managers and teams follow in a separate pull request (the
  API is in place); until then HR maintains them through the API.
- Bad: a member with an organisation-wide role is still in every home's scope (ADR-0136); a line or
  team does not narrow that.

## More information

- Migration 0162 (`staff_line_manager`, `staff_team`, `staff_team_member`, and the extended
  `app.development_scope_members_for`).
- Tests: `packages/db/test/reporting-lines.test.ts`, `apps/api/test/reporting-lines.test.ts`.
- workforce.md section 3 rule 7, the API section and the known gaps; records-of-processing and
  data-standards (reporting lines).
