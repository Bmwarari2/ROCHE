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

## Checks

See the PR's test evidence.
