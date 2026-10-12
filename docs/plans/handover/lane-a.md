# Lane A: schema and API (owns migrations)

Scope over the lane: slices 11 to 13 schema and API on the domain rules already on `main`
(`packages/domain/src/operations`, `quality`, `comms`, `platform`), one PR per slice part:

- slice 11: downtime pack with outages and back-entry (`docs/specs/operations.md`, OPS-028);
  inspector evidence pack and statement of purpose (`docs/specs/quality.md`, QUAL-003, QUAL-009,
  ADR-0050); letter and email templates (`docs/specs/comms.md` "Letter and email templates",
  COMMS-007, ADR-0051);
- slice 12: family feed under a sharing decision (ADR-0061; `comms.md` section 2.1), channels,
  notifications, visit booking (COMMS-001, INTG-011);
- slice 13: permission-aware search (ADR-0070), the free full export, DPIA sign-off, onboarding
  (feeding `validatedToolsWithLinks`) and sample data (`docs/specs/platform-completions.md`).

## Your first PR now: slice 11 part 1, downtime pack and outages schema

Branch `feat/operations-downtime-schema`. Follow the `add-migration` skill. Build what
`operations.md` section 2 lists:

- `downtime_pack` (append-only) and `outage` (mutable, versioned with `expected_version`), with
  `tenant_id`, forced RLS and policies that follow the location and the people on the pack
  (section 2's visibility rules), grants (no UPDATE/DELETE on append-only), audit triggers as the
  other tables have them, retention classes `downtime_pack` and `downtime_record` (check
  `docs/specs/retention.md` and the retention schedule seed);
- the expand-only back-entry columns on `care_note`, `observation`, `body_map_mark`,
  `activity_record`, `visit_log`;
- the location settings `downtime.mar_location` and `downtime.peep_location` where location
  settings live today;
- the `operations.downtime.read` and `operations.downtime.manage` permissions if not yet in
  `packages/domain/src/platform/permissions.ts`, held by the roles section 3 names (regenerate the
  permission matrix doc);
- isolation tests in `packages/db/test` proving cross-tenant denial and the location/people rule,
  and the RLS coverage test passing.

If the whole of section 2 plus tests exceeds about 600 changed lines (excluding drizzle snapshots),
put the back-entry columns in this PR and the tables in the next, or the reverse; your call.
Update `docs/specs/data-standards.md` and `docs/compliance/records-of-processing.md` if a field is
new to them (the spec says field mapping is already there; check). Label `data-protection` if
you touch them.

The API (routes, nightly worker job, PDF via the existing transfer-pack PDF writer of ADR-0040,
back-entry on care write routes, audit and outbox events of section 5) is your next PR. Don't
start it in this one.
