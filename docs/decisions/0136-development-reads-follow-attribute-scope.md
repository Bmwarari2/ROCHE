---
status: "proposed"
date: 2026-11-08
decision-makers: lead engineer (Claude Code lead session), for the owner
consulted: security reviewer and clinical safety reviewer (agents); owner to confirm (H-1640); CSO to accept H-1641 and H-1642
informed: engineering
---

# Development reads and writes follow attribute scope

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
(H-1640), because it is the least-privilege default the constraints digest asks for and it needs no
new data.

- **Organisation-wide holders keep the whole organisation.** A role with no person scope (HR's), a
  tenant-scoped role (the owner's), or a role or grant held organisation-wide.
- **A holder at a home reads and writes the records of the members who work there**: a role there, or
  an access grant there (acting up, for example). "Works there" is as `app.works_at` (migration 0115)
  counts it: a role in force at that home or across the organisation, or that home on their staff
  profile. They read and write no one else's development records.
- **Members with an organisation-wide role are in every home's scope.** For example, the HR director
  or the Nominated Individual hold organisation-wide roles, so every home's manager reads their
  training, competence and supervision records, as `app.works_at` counts them. The owner confirms
  this under H-1640.
- **Writes follow the same scope in the policies themselves** (training records, supervisions,
  competence sign-offs and withdrawals, revalidation evidence, training certificates), not only
  through the read policy. The HZ-119 sign-off guard looks up withdrawals with definer rights
  (`app.competence_withdrawn_after`), so a narrower read never hides a withdrawal from it.
- **LMS import is for organisation-wide holders of `workforce.training.manage` only**, in the API
  (403 `lms_import_organisation_wide`, audited) and in row-level security
  (`app.holds_staff_permission_everywhere`). Its learner links and rows name members across every
  home, and a commit by a home's manager would otherwise fail on members out of scope. This is the
  simpler of the two options the security review offered (the other: scope each row by its worker).
- **A member reads their own** (`workforce.self.read`), as before.
- **Assigned-people and self scopes give no development reads**, as before.
- **The reminder tasks about a member** (`workforce.training_expiry`, `workforce.competence_expiry`,
  `workforce.supervision_due`: source `tenant_user`) are visible only to holders whose scope covers
  that member. A workforce task about no member keeps the rule of migration 0079.
- **Enforced twice.** Migration 0161 adds `app.development_scope_members(permissions, members)` (a
  set-based definer owned by `harbour_workforce_definer`, ADR-0133: the reader's homes are found
  once), with `app.holds_staff_permission_for`, `app.reads_development_of` and
  `app.holds_staff_permission_everywhere` over it. It changes the read and write policies of the
  development tables, their earlier versions, e-learning, training certificates, LMS import and
  the task policy. The API's matrix and supervisions list ask the same definer once per list, and a
  member's record asks it once, so the lists match row-level security.

### Consequences

- Good: a Registered Manager or deputy sees their own home's staff only; HR and the owner see
  everyone, as before; one predicate serves the records, the lists and the reminders.
- Good: the reminder task visibility question recorded in WORK-009 slice 2 (a reminder about a
  member was visible to every holder at any home) is closed without giving the task a location,
  which would have shown it to everyone at the home (`app.task_visible`, migration 0008).
- Neutral: a member who works across the organisation (an organisation-wide role, such as the HR
  director or the Nominated Individual) is in every home's scope, as `app.works_at` counts them.
- Neutral: a home's manager no longer runs LMS imports; HR or the owner does.
- Bad: there is no team or line-manager scope for staff (scope kinds are tenant, location, assigned,
  self and none), so a team lead's scope is their home. Option 3 needs a line-manager field first;
  it stays a known gap in workforce.md.
- Bad, accepted by the CSO as a residual risk (H-1641): a revalidation confirmer must hold training
  or supervision rights in a scope that covers the nurse, since the confirmation is a write in the
  nurse's scope. Naming a manager from another home is refused when they are named (422
  `confirmer_not_permitted`), never discovered at confirmation, and the confirmer list offers only
  those who may confirm (`app.revalidation_confirmer_candidates(nurse)`); this could delay a
  confirmation, mitigated by HR, who may always confirm.
- Neutral, accepted by the CSO (H-1642): a home's manager sees the training, competence and
  supervision of the staff in their scope only. Point-of-care gating is unaffected: the competence
  port reads every worker's sign-offs with the system's rights (ADR-0085, HZ-119).
- Neutral: the HZ-119 withdrawal lookup (`app.competence_withdrawn_after`) answers only inside the
  sign-off guard, its only caller, so a direct call never reveals a withdrawal.

### Confirmation

`packages/db/test/development-scope.test.ts` (HR, a tenant-scoped holder, a home's manager, an
acting-up access grant, an assigned-scope role, the member and another organisation, across the
training, supervision, sign-off, withdrawal, revalidation, e-learning, earlier-version and
certificate tables and the reminder tasks; out-of-scope writes refused without RETURNING; the
HZ-119 guard; the context definers that read tasks) and
`apps/api/test/development-scope.test.ts` (the same through the supervisions list, the training
matrix, the member's record and the tasks list); `apps/api/test/lms-import.test.ts` (a home's manager
refused in words, audited); `definer-acls.test.ts` lists the new definers and grants.

## More information

- Master prompt section 4; constraints digest section 4; ADR-0002; ADR-0133.
- Migrations 0073 (`app.holds_staff_permission`), 0079 (`app.reads_development`, task visibility),
  0115 (`app.works_at`), 0161 (this decision).
- WORK-009 (#214 slice 1, #216 slice 2); the lead's decision of 08/11/2026.
- To change it: a later migration may widen `app.holds_staff_permission_for` (for example, back to
  organisation-wide), recorded in a new ADR that supersedes this one.
