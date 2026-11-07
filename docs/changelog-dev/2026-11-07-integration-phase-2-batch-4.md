# Phase 2 merge batch 4 (migrations 0147 to 0151)

Branch `integration/phase-2-batch-4`, from `main` e1524309, which already holds 0145 (no SMS at
launch, #178), 0146 (sync buckets per home, #177) and the dm+d job's Terraform (#179). Merged with
merge commits, one branch at a time.

## What changed

- Merged in this order, each renumbered straight after its merge (file, snapshot, journal idx, tag
  and `when`, and every reference in code, tests and docs):
  - `feat/mobile-meds-sync` daa7df8e: slice 68, medicines on the phone, 0149 to 0147;
  - `feat/integrations-hr-link-screens` 2651e0fb: slices 89 and 90, pay through Thapsus-HR and the
    link's screens, 0151 to 0148;
  - `feat/platform-member-lifecycle-v2` eee5cd04: H-566 completed, 0153 to 0149;
  - `feat/meds-web-stock-errors` 8c8d008c: slice 55, 0155 to 0150;
  - `feat/meds-web-rounds-prn` 53ae2932 (slice 53) and `feat/meds-printable-mar` 71f039f2
    (slice 50), no migrations;
  - `fix/platform-definer-owners` 974a16cc: ADR-0133, 0154 to 0151, last.
- Snapshots chained in merge order; after each renumbering the latest snapshot was regenerated from
  the merged schema, and `drizzle-kit generate` finds no change at the end.
- 0151 also takes over the definers batch 4 added (ADR-0133 now says each later migration sets its
  own definers' owner):
  - the sync routing functions of 0146 (`sync_person`, `set_sync_location`,
    `set_task_sync_location`, `set_handover_sync`, `move_sync_location`) belong to
    `harbour_platform_definer`, with column grants on the routing columns only and what their
    tables' policies read;
  - `app.is_sync_location_move` names that role instead of `harbour_owner`, so a routing move is
    let through only inside `app.move_sync_location`;
  - `app.request_sign_in_erasure` of 0149 belongs to `harbour_member_owner`, which owns the rest
    of the member lifecycle;
  - `definer-acls.test.ts` lists the new grants and checks that the platform definer updates only
    the routing columns.
- Conflicts resolved:
  - the side navigation and the Medicines tab carry the round (53), stock and reports (55) and the
    print card (50) together;
  - the hazard log keeps every branch's rows; HZ-140 (pay) joins after HZ-138; HZ-133 takes slice
    90's settings page row; slice 88's open control on incoming shifts is dropped, because the rota
    stays with Harbour (ADR-0126, confirmed 06/11/2026);
  - the human actions are H-1401 to H-1411 in order, then the lifecycle's H-1461 to H-1469;
  - the message catalogues were merged by key, three-way.
- OpenAPI and the client were regenerated (the lifecycle's reinstatement description had drifted).

## Checks

- `drizzle-kit generate`: no schema changes.
- Typecheck (10 packages) and Biome: clean, with warnings only.
- Suites on a private Postgres: db 1561, API 2842, domain 8174, web 2957, mobile 1425, sync 166
  and i18n 48, all passing.
- Security review of the definer extension: approve. Its tidy-ups are in (0151 revokes PUBLIC from
  two 0146 trigger functions before their owner changes; ADR-0133 says how a later routing
  backfill must run). Left as a follow-up: column grants on `break_glass_event` for the policies
  instead of the whole table.
