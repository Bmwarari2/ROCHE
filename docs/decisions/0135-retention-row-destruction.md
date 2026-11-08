---
status: "proposed"
date: 2026-11-08
decision-makers: lead engineer (Claude Code lead session), for the owner
consulted: data protection officer (H-1556 to H-1560 and H-1581 to H-1587, provisional answers pending review at the testing phase)
informed: engineering
---

# Destroying database rows when their retention class ends

## Context and problem statement

The retention engine built in Phase 1 (PLAT-012) destroys documents only, and only when a person
asks. Nothing destroys database rows when their retention class ends: 133 of the 135 Phase 2 tables
that hold personal data are never swept ([retention sweeps plan](../plans/retention-sweeps.md),
sections 1 to 4). Master prompt section 5.1 asks for retention with legal hold: soft delete, then
destruction with a certificate. [ADR-0109](0109-per-organisation-crypto-shredding.md) already decided
that database columns are not field-encrypted, so a row cannot be destroyed by destroying a key: it
must be deleted or its personal columns cleared. The database refuses that today: 98 of the tables
refuse DELETE by trigger for every role, the application role has no DELETE grant, and 64 tables have
no `deleted_at`. How should rows be destroyed, by which role, driven by which list, and with what
approval?

## Decision drivers

- Nothing is destroyed without a person's approval; a legal hold always wins (master prompt 5.1;
  [retention-and-deletion.md](../compliance/retention-and-deletion.md) section 1).
- Least privilege: no login role, superuser or `BYPASSRLS` role destroys rows
  ([ADR-0002](0002-tenancy-and-row-level-security.md), [ADR-0133](0133-definer-functions-owned-by-nologin-roles.md)).
- One source of truth for which class applies to which table, so the DSAR erasure check and the sweep
  agree.
- No copy outlives the record: earlier versions in `record_version`, stored files, DSAR bundles and
  devices go with it.
- Report before acting, one class at a time, so the DPO signs off real evidence first.
- No statutory figure in code: periods from `retention_class`, the grace period and batch size from
  the rate table.

## Considered options

For the soft delete, which decides most of the shape:

- A. A retention-only column, `retention_deleted_at`, on every table in the registry.
- B. Reuse `deleted_at`, adding it to the 64 tables without it.

For the owner of the destruction functions:

- One NOLOGIN role, `harbour_retention_owner`, reaching every context.
- One retention owner per bounded context, as ADR-0133 does for definers.

## Decision outcome

Chosen option: **A, a retention-only column**, with one NOLOGIN owner reaching every context, because
retention's soft delete must not be confused with, or undone by, a feature's own `deleted_at` (the
Thapsus-HR link, for example, clears `deleted_at` on a leaver record), and because a purge must delete
children before parents across contexts in one transaction. The six points:

1. **Row destruction.** Approval sets `retention_deleted_at` (nullable, no default; expand migrations
   per context). A restrictive SELECT policy for `harbour_app` (`retention_deleted_at IS NULL`) hides
   the rows from every API read, search, export and DSAR collection in one place, and the sync streams
   filter on it. A grace period follows: 30 days, rate table key `retention.grace_days` (provisional,
   H-1556); a hold placed in that time restores the record, and Thapsus support restores a batch only
   on the organisation's written request. When the grace period ends the rows are deleted, or, for
   rota, pay runs, audits and outbreak line lists, their personal columns are cleared and the
   anonymous row kept (provisional, H-1560). One signed certificate is issued per batch, class and
   table, with a new `batch_id` column. Stored files linked to the record are deleted version by
   version, as ADR-0109 decided; no per-subject keys are introduced. Deleted rows leave point-in-time
   recovery after 7 or 35 days, stated on the certificate, which meets the requirement for database
   rows (ADR-0109; provisional, H-1582).
2. **The owner.** A new NOLOGIN role, `harbour_retention_owner`, created by `pnpm db:bootstrap` with
   SET-only membership for `harbour_owner`; never a login role, a superuser or `BYPASSRLS`. It owns
   `app.retention_soft_delete`, `app.retention_restore` and `app.retention_purge` (`SECURITY DEFINER`,
   `search_path` pinned with `pg_temp` last, EXECUTE for `harbour_app` only). Table names come only
   from a fixed list inside the database (`app.retention_tables()`, children before parents), never
   from an argument; each function checks the batch belongs to the organisation in context and is in
   the right state. Its grants are DELETE on the listed tables and on `record_version`, UPDATE on
   `retention_deleted_at` and the clearable columns only, and the SELECT the row-level policies need.
   `app.forbid_mutation()` gains a third exception: DELETE, or an UPDATE that changes only the
   retention column or the listed clearable columns, when the current user is this role and
   `app.retention_destruction` is `on`. `audit_event` stays refused.
3. **The registry.** A typed registry, one entry per table with personal data (class, trigger source,
   subject, parent, method, linked files), split by bounded context, is the single table-to-class
   source. The export catalogue's `retention` field is derived from it or checked against it. A
   `packages/db` test fails when a personal table has no entry, an entry names a class that is not a
   retention.md row, or a trigger column does not exist.
4. **`record_version`.** The purge deletes the `record_version` rows of every destroyed record,
   including a record whose columns were cleared, so no earlier copy keeps what was cleared.
5. **Audit events.** Out of scope for the first slices. They hold opaque ids and codes, are
   hash-chained and archived in a bucket locked for 365 days. The provisional answer (H-1559) keeps
   them for their own class as opaque ids, not destroyed with the record, and clears the free-text
   `reason` when the record is destroyed; slice 14 builds that, or a chain-aware purge if the DPO
   decides otherwise.
6. **Modes and approval.** Per organisation and class, held as a tenant setting through OpenFeature:
   `off` (the default), `report`, `propose`, `destroy`, moved one step at a time; `destroy` is set
   per class, in the order of the plan's slice 11, each after the DPO signs off its report from a pilot
   organisation (provisional, H-1587). Nothing is destroyed without approval by two different people:
   a reviewer with `platform.retention.manage` and step-up, and a second person, as the
   whole-organisation shred does (provisional, H-1581). Records of a `tenant_policy` class are never
   proposed (provisional, H-1585). Holds are checked when a batch is proposed, when it is approved
   and again under the organisation's retention lock when rows are purged.

**Exception to ADR-0133.** ADR-0133 gives each bounded context its own NOLOGIN definer owner.
`harbour_retention_owner` reaches every context's personal tables. This is a recorded exception, on the
same reasoning as `harbour_sample_owner` for sample-data removal: one fixed table list, one trigger
exception and one flag, each pinned by a test, are easier to prove than fourteen; and a purge must
delete children before parents across contexts (a person's medicines, care and safety records) in one
transaction under one lock, which per-context owners cannot do without calling each other. The role
is narrower than a context definer in what it may do (delete and clear listed columns only, through
three functions), though wider in where.

### Consequences

- Good, because retention's soft delete has its own column, so no feature can undo it, and one
  restrictive policy hides the rows everywhere.
- Good, because one list, one role and one exception are each pinned by a test, as sample removal is.
- Good, because the registry ends the disagreement between the export catalogue and retention.md.
- Good, because earlier versions go with the record, and certificates prove what went and when the
  backups stop holding it.
- Bad, because every table in the registry gets a new column and policy (expand migrations, several
  PRs) and the sync streams change.
- Bad, because one role reaches every context's personal tables; a flaw in its three functions is
  wider than a flaw in one context's definer. The fixed list, the flag and the tests limit this.
- Bad, because audit events stay, with ids, for 8 years after the record they describe is gone, and
  archived copies outlive any deletion by up to a year.
- Bad, because copies stay in point-in-time recovery for up to 35 days after the purge.

### Confirmation

- `packages/db/test/definer-acls.test.ts` pins the role's grants and the three functions' ACLs.
- A test fails when a table is in the registry but not in `app.retention_tables()`, or the reverse.
- Tests prove: another role with the flag set is refused; this role without the flag is refused;
  another organisation's batch is refused; a held record is never deleted; a soft-deleted row is
  invisible to `harbour_app` and to the sync streams.
- The domain rules (plan section 5.2) have table-driven tests per class, under the 90% coverage gate.

## Pros and cons of the options

### A. A retention-only column

- Good, because it cannot be confused with or cleared by a feature's `deleted_at`.
- Good, because one restrictive policy covers every read path at once.
- Bad, because it adds a column to every registry table, including those that already have
  `deleted_at`.

### B. Reuse `deleted_at`

- Good, because 71 of the tables already have the column.
- Bad, because `deleted_at` already has feature meanings, and ordinary code can clear it, undoing a
  retention soft delete.
- Bad, because every read path that ignores or clears `deleted_at` would need auditing.

### One owner per bounded context

- Good, because it follows ADR-0133 without an exception.
- Bad, because a purge across contexts would need several owners in one transaction, in the right
  order, and fourteen lists and exceptions to keep in step.

## More information

[Retention sweeps plan](../plans/retention-sweeps.md) (sections 5 and 8; slices 7 to 10 build this);
[retention.md](../specs/retention.md); [retention-and-deletion.md](../compliance/retention-and-deletion.md);
[ADR-0109](0109-per-organisation-crypto-shredding.md); [ADR-0133](0133-definer-functions-owned-by-nologin-roles.md);
migration 0069 (sample removal, the precedent). Every DPO answer cited is provisional; this ADR is
revisited if the DPO changes one at the testing phase, and must be accepted before slice 7.
