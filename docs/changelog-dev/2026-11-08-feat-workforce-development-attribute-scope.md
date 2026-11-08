# Development reads follow attribute scope (ADR-0136)

Branch `feat/workforce-development-attribute-scope`, from `main` 02d1f7c1. The WORK-009 follow-up
the lead assigned on 08/11/2026.

## What changed

- ADR-0136 (proposed; the owner confirms, H-1609): development reads follow attribute scope.
  Organisation-wide holders (HR's role with no person scope, a tenant-scoped role, a role or grant
  held organisation-wide) read every member; a holder at a home reads the members who work there,
  as `app.works_at` counts them; a member reads their own.
- Migration 0161 (`development_attribute_scope`; number taken at merge):
  - `app.holds_staff_permission_for(permission, member)`, a definer owned by
    `harbour_workforce_definer` (ADR-0133), executable by `harbour_app`, `harbour_owner` and
    `harbour_care_definer` (which evaluates the task policy), and `app.reads_development_of(member)`;
  - the read policies of `training_record`, `competence_sign_off`, `competence_withdrawal`,
    `supervision_record`, `revalidation_evidence`, their earlier versions, `elearning_attempt`,
    `elearning_statement` and training certificates now use it;
  - the task policy: a workforce reminder about a member (source `tenant_user`, with a
    development permission) is visible only to holders whose scope covers that member; other
    workforce tasks keep migration 0079's rule. The task still has no location.
- API: the training matrix and the supervisions list show only the members in the reader's scope;
  a member's development record out of scope reads as 404; a write for a member out of scope is
  refused by the database as an audited 403.
- Web: the "Show staff at" hint now says the list shows the staff the reader may see.
- Docs: workforce.md (rule 7, the API notes, the screens table, known gaps), records of processing
  (access narrowed), data standards, STATUS, the feature register, human actions (H-1609).

## Security review round 1 (applied in one commit)

- LMS import is for organisation-wide holders of `workforce.training.manage` only, in the API (403
  `lms_import_organisation_wide`, audited as `workforce.lms_import.refused`) and in row-level
  security (`app.holds_staff_permission_everywhere`): the simpler of the two options offered. The
  LMS tests give the Registered Manager HR's role and check a home-only manager is refused.
- Writes follow the scope in the policies themselves (training records, supervisions, sign-offs,
  withdrawals, revalidation evidence, training certificates). The HZ-119 sign-off guard looks up
  withdrawals through a definer, `app.competence_withdrawn_after` (owned by
  `harbour_workforce_definer`, which now reads `competence_sign_off` and `competence_withdrawal`).
  The hazard log's HZ-119 verification names the new test.
- ADR-0136 and H-1609 say that members with an organisation-wide role (the HR director, the
  Nominated Individual) are in every home's scope.
- Performance: one set-based definer, `app.development_scope_members(permissions, members)`, finds
  the reader's homes once; `holds_staff_permission_for` and `reads_development_of` wrap it; the
  lists ask it once per list; the task policy tests cheap columns before asking it, and reuses
  `app.task_visible_with` for every other task. Policies change with ALTER POLICY, keeping their
  roles.
- Grants: `harbour_care_definer` and `harbour_platform_definer` (the context definers that read or
  route tasks) may execute the definer; a test runs both against tasks about members.
- The database scope test now covers sign-offs, withdrawals, revalidation evidence, e-learning
  attempts, earlier versions and certificates, an acting-up access grant and an assigned-scope
  role (none); agency workers hold location roles, so the home case covers them.

## Checks

See the PR's test evidence.
