---
status: "proposed"
date: 2026-11-08
decision-makers: lead engineer (Claude Code lead session), for the owner
consulted: security reviewer (agent); owner to confirm (H-1609)
informed: engineering
---

# Development reads follow attribute scope

## Context and problem statement

Members' development records (training records, observed competence sign-offs and their
withdrawals, supervisions, revalidation evidence, e-learning attempts and training certificates)
have been readable by any holder of a workforce read permission anywhere in the organisation:
`app.reads_development()` (migration 0079) builds on `app.holds_staff_permission()` (migration
0073), which counts a permission held at any home as organisation-wide, because HR is
organisation-wide (master prompt section 4). WORK-009 (#214, #216) put these records into lists
across staff (the training matrix and the supervisions and appraisals due list) and raised reminder
tasks about members, so a Registered Manager of one home now sees every home's staff in one place.
The lead kept that organisation-wide in WORK-009 and asked, on 08/11/2026, for this decision on its
own: should development reads follow the attribute scope of the constraints digest section 4
(location, team, assigned people), so each reader sees only the members in their scope?

## Decision drivers

- Least privilege (master prompt sections 4 and 5.3): RBAC decides what, attribute scope decides
  to whom, enforced in the API and again in row-level security.
- HR functions stay organisation-wide: HR's role has no person scope, and the owner's is tenant-wide.
- One rule for the records, the lists and the reminder tasks, so a list never shows a member whose
  record the reader cannot open.
- Reuse the existing scope model; no new scope kind.

## Considered options

1. Keep development reads organisation-wide for every holder (as 0073 and 0079).
2. Development reads follow attribute scope: organisation-wide holders keep the organisation; a
   holder at a home reads the members who work there.
3. A line-manager relationship per member, read by that manager only.

## Decision outcome

Chosen option: **2, development reads follow attribute scope**, provisional until the owner confirms
(H-1609), because it is the least-privilege default the constraints digest asks for and it needs no
new data.

- **Organisation-wide holders keep the whole organisation.** A role with no person scope (HR's), a
  tenant-scoped role (the owner's), or a role or grant held organisation-wide.
- **A holder at a home reads the members who work there**, as `app.works_at` (migration 0115) counts
  it: a role in force at that home or across the organisation, or that home on their staff profile.
  They read no one else's development records.
- **A member reads their own** (`workforce.self.read`), as before.
- **Assigned-people and self scopes give no development reads**, as before.
- **The reminder tasks about a member** (`workforce.training_expiry`, `workforce.competence_expiry`,
  `workforce.supervision_due`: source `tenant_user`) are visible only to holders whose scope covers
  that member. A workforce task about no member keeps the rule of migration 0079.
- **Enforced twice.** Migration 0161 adds `app.holds_staff_permission_for(permission, member)` (a
  definer owned by `harbour_workforce_definer`, ADR-0133) and `app.reads_development_of(member)`,
  and changes the read policies of the development tables, their earlier versions, e-learning,
  training certificates and the task policy. The API's matrix, supervisions list and member record
  read the same predicate, so the lists match row-level security.

### Consequences

- Good: a Registered Manager or deputy sees their own home's staff only; HR and the owner see
  everyone, as before; one predicate serves the records, the lists and the reminders.
- Good: the reminder task visibility question recorded in WORK-009 slice 2 (a reminder about a
  member was visible to every holder at any home) is closed without giving the task a location,
  which would have shown it to everyone at the home (`app.task_visible`, migration 0008).
- Neutral: a member who works across the organisation (an organisation-wide role) is in every
  home's scope, as `app.works_at` counts them.
- Bad: there is no team or line-manager scope for staff (scope kinds are tenant, location, assigned,
  self and none), so a team lead's scope is their home. Option 3 needs a line-manager field first;
  it stays a known gap in workforce.md.
- Neutral: write policies still check the permission anywhere, but every development write in the
  API returns or first reads the row, so the read policy refuses it outside scope (an audited 403,
  tested for a training record). Narrowing the write policies themselves is left for a later
  migration.

### Confirmation

`packages/db/test/development-scope.test.ts` (HR, a tenant-scoped holder, a home's manager, the
member, another organisation; records and reminder tasks) and
`apps/api/test/development-scope.test.ts` (the same through the supervisions list, the training
matrix, the member's record and the tasks list); `definer-acls.test.ts` lists the new definer.

## More information

- Master prompt section 4; constraints digest section 4; ADR-0002; ADR-0133.
- Migrations 0073 (`app.holds_staff_permission`), 0079 (`app.reads_development`, task visibility),
  0115 (`app.works_at`), 0161 (this decision).
- WORK-009 (#214 slice 1, #216 slice 2); the lead's decision of 08/11/2026.
- To change it: a later migration may widen `app.holds_staff_permission_for` (for example, back to
  organisation-wide), recorded in a new ADR that supersedes this one.
