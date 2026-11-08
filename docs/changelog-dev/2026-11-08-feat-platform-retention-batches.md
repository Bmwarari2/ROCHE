# Destruction batches (retention sweeps plan, slice 6)

Branch `feat/platform-retention-batches`, from `main` at 89d118d0 (the report-only sweep, #215).

## What changed

- **Propose mode** (plan 5.4; ADR-0135 point 6). A second flag, `platform.retention.sweep_propose`,
  off by default, organisation-wide and never set by Flagsmith, on top of
  `platform.retention.sweep_report`: report alone gives `report`, both give `propose`, propose
  alone gives `off` (`sweepModeOf`, one step at a time). Proposals destroy nothing, so the mode
  covers every class; a mode per class comes with `destroy`. No in-app switch: Thapsus sets the
  flag on the organisation's written request (provisional, H-1620).
- **What is proposed** (`packages/domain/src/platform/retention-batches.ts`, pure, 100% of lines
  covered). `proposalPlan` says whether a registry table's records may be proposed: only tables the
  report decides, never one about a member of staff (subject or further subject), never one whose
  subject is found only through its parent. `proposalOutcome` decides each row: a hold first, then
  an open case about the person (as a hold until slice 12), then `sweepDecision` through the
  report's own `groupDecision`; only `due` is proposed, with its rule, trigger date and due date.
  `planBatches` makes one batch per class, oldest due first, at most `retention.batch.max_records`
  (a new rate table row, 5000, to verify), skipping a class with a proposed batch and a record
  already in one; a limit that is not a whole number above zero proposes nothing.
- **The sweep** (`apps/api/src/services/retention-batches.ts`). After the report, in the same
  transaction and under the organisation's retention lock, it reads, for each table the report
  found due, its rows one by one with the report's facts (`factColumns`, shared with the report),
  whether a person they name has an open DSAR case (about them or a contact of theirs), complaint
  or safeguarding concern, and the subject's ids; it writes each batch, its items and the audit
  event `platform.retention.batch_proposed` (batch id, class, counts per table; no record or
  subject id). The report row's mode is now `report` or `propose`.
- **`destruction_batch`** (migration 0161): a mutable aggregate (`version`, `touch_mutable`,
  `capture_version`), `proposed` then `cancelled` with who, when and a reason code; a guard
  trigger allows only that move and never a change to what was proposed; never deleted; one
  proposed batch per class (a partial unique index). No personal data (`no-personal-data.ts`).
- **`destruction_batch_item`** (migration 0161): append-only; table, record id, class, trigger and
  due dates, the subject's kind (`person`, `applicant`, `none`) and ids. Personal data by opaque id:
  a registry entry (`permanent`, method `never`, provisional H-1622) and an export catalogue entry
  (`personal: true`).
- Both tables: forced RLS, the tenant policy, a tenant-wide-only restrictive policy for
  `harbour_app`; only the system inserts, and only as `proposed`; a cancel is a holder of
  `platform.retention.manage`'s own, with UPDATE granted on the four cancel columns only.
- **Routes** (`apps/api/src/routes/retention-batches.ts`): `GET /v1/retention/batches`,
  `GET /v1/retention/batches/{id}/items` (pages by id) and
  `POST /v1/retention/batches/{id}/cancel` (`expectedVersion`, reason code; 409 when stale or
  decided), tenant-wide holders of `platform.retention.manage` with step-up; audited as
  `platform.retention.batches_listed`, `platform.retention.batch_viewed` and
  `platform.retention.batch_cancelled`, ids, codes and counts only. OpenAPI and the typed client
  regenerated.
- **Nothing is hidden or destroyed.** The API test fingerprints every registry record table in both
  test organisations (row count and an MD5 of every row) before and after proposing, a second run
  and a cancel, and finds them equal (a cancel adds only the batch's own earlier version to
  `record_version`).

## Tests

- `packages/domain/src/platform/retention-batches.test.ts`: the mode from the two flags; a plan
  per kind of entry (proof, undecided, staff subject, staff further subject, subject through the
  parent, person, applicant, no one); an outcome per case (held, open case, in care, kept, open
  complaint, `tenant_policy`, due); batches by class, order, limit, open class, record already
  proposed and a wrong limit; counts per table; cancel problems.
- `packages/db/test/retention-batches.test.ts`: each organisation sees only its own, tenant-wide
  only; a person, a cancelled insert or another organisation's insert is refused; one proposed
  batch per class; a subject on an item about no one is refused; a cancel by someone without the
  permission, in another's name or with free text is refused, then succeeds once and keeps the
  earlier version; the proposal never changes, even as the owner; nothing is deleted; items never
  change.
- `apps/api/test/retention-batches.test.ts`: propose without report proposes nothing; with both,
  a discharged resident's records are proposed and a held one's and a complained-of one's are not;
  no undecided or staff table; no id in the audit events; no second batch for a class; pages and
  404; refused for the carer, nurse and location-scoped manager and across organisations; a cancel
  without step-up, with free text or a stale version is refused, then succeeds once; the class is
  proposed again afterwards.

## Data protection and clinical safety

- `data-standards.md` and `records-of-processing.md` gain the two tables (items hold record and
  subject ids). `retention.md` lists them as kept permanently and states the open-case rule.
- Not clinical: no hazard log change. The sweep reads and proposes; nothing reaches care or
  medicines, and no record is hidden or changed.

## What is next

- Slice 7: the retention role and the `forbid_mutation` exception. Slice 9 approves a batch (two
  people, H-1581) and soft-deletes it; it re-checks holds and adds item state rows.
- Provisional DPO decisions, logged in `docs/plans/human-actions.md`: one organisation-wide
  propose setting with no in-app switch yet (H-1620), how batches honour H-1612 before slice 12
  (H-1621) and batches kept permanently (H-1622).
- Performance: propose mode reads each due table's rows one by one in Node; fine for the demo and a
  pilot, to measure on a large organisation before slice 11.
