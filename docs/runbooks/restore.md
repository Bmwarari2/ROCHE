# Database restore

| Item | Value |
| --- | --- |
| Objectives | **RPO 15 minutes**, **RTO 4 hours** (master prompt 7) |
| Backups | RDS automated backups with point-in-time recovery (PITR) and daily snapshots, retained 35 days; manual snapshot before every production migration; S3 versioning on document buckets |
| Disaster recovery stance | AWS has no second UK region, so recovery is Multi-AZ plus PITR, and the mobile app's offline mode is the business-continuity path (ADR-0001) |
| Drill | Quarterly, logged in section 8 |
| Status | Draft, Phase 0. Resource names below follow the Terraform in `infra/`; confirm them against the environment before use |

## 1. Choose the scenario

| Scenario | Use |
| --- | --- |
| A. Availability-zone or instance failure | No restore. RDS Multi-AZ fails over automatically (typically within minutes). Verify with the checks in section 6 |
| B. Bad change affecting part of the data (bad migration, faulty job, one tenant's data damaged) | Restore to a **new** instance at a point before the change, extract the affected rows, and repair production through an audited script. Do not roll the whole database back for one tenant |
| C. Database lost or corrupted as a whole | PITR to a new instance at the latest safe time, then cut over (sections 3 to 5) |
| D. Need a point older than PITR allows, or a pre-migration state | Restore from the named snapshot (section 3.2) |
| E. Security compromise (data altered by an attacker) | Follow [incident-response.md](incident-response.md) section 5 first (preserve evidence), then B or C |

Declare an incident (SEV1 for C, D and E; at least SEV2 for B), page the CSO, and tell tenants to use their downtime procedure if staff cannot work ([incident-response.md](incident-response.md)).

## 2. Before restoring: the offline-device gap

Devices keep working offline and upload when they can. Writes that the API **acknowledged after the restore point** are no longer on the server after a restore, and the device has already removed them from its upload queue, so they will not be re-sent. On the next sync, devices replace their local copy with the restored server state.

1. Keep the API upload endpoints and PowerSync **stopped** until the gap is understood (section 4).
2. Establish the gap window: restore point to the time writes stopped.
3. From API access logs (Grafana Cloud, outside the database), list the tenants and devices that uploaded during the window.
4. With the CSO, tell those tenants which period to re-check (care notes, charts, administrations, incidents) and that staff must not re-give medicines based on the restored MAR without checking (hazards HZ-004 and HZ-006). Issue a field safety notice if the CSO decides.
5. Open an ADR action for an upload journal (accepted client mutations written to append-only storage in S3) so that the gap can be replayed automatically in future `[engineering decision]`.

## 3. Restore the database

Set variables (values from Terraform outputs):

```sh
export AWS_REGION=eu-west-2
export SRC=harbour-prod-db                    # source instance identifier
export TGT=harbour-prod-db-restore-$(date -u +%Y%m%d%H%M)
export SUBNETS=harbour-prod-db                # DB subnet group
export SG=sg-xxxxxxxx                         # database security group
export PG=harbour-prod-pg17                   # parameter group (pgAudit, logical replication)
```

### 3.1 Point-in-time recovery (scenarios B, C)

```sh
# Latest time PITR can reach (normally within 5 minutes of now)
aws rds describe-db-instances --db-instance-identifier "$SRC" \
  --query 'DBInstances[0].LatestRestorableTime' --output text

# Restore to a chosen UTC time before the damaging change...
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SRC" \
  --target-db-instance-identifier "$TGT" \
  --restore-time 2026-10-11T09:30:00Z \
  --db-subnet-group-name "$SUBNETS" \
  --vpc-security-group-ids "$SG" \
  --db-parameter-group-name "$PG" \
  --multi-az --no-publicly-accessible --deletion-protection

# ...or to the latest restorable time (scenario C), replacing --restore-time with:
#   --use-latest-restorable-time

aws rds wait db-instance-available --db-instance-identifier "$TGT"
```

The restored instance is encrypted with the same KMS key as the source.

### 3.2 Snapshot restore (scenario D)

```sh
aws rds describe-db-snapshots --db-instance-identifier "$SRC" \
  --query 'DBSnapshots[].[DBSnapshotIdentifier,SnapshotCreateTime,SnapshotType]' --output table

aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "$TGT" \
  --db-snapshot-identifier <snapshot-identifier> \
  --db-subnet-group-name "$SUBNETS" \
  --vpc-security-group-ids "$SG" \
  --db-parameter-group-name "$PG" \
  --multi-az --no-publicly-accessible --deletion-protection

aws rds wait db-instance-available --db-instance-identifier "$TGT"
```

### 3.3 Partial repair (scenario B)

Connect to `$TGT` with the read-only role, extract the affected tenant's rows for the affected tables (always filter by `tenant_id`), and write a repair script reviewed by a second engineer. Run it against production with the maintenance role. Corrections to append-only event tables are made as new correction events that reference the original, never as updates. Record the repair in the incident and in `audit_event`. Delete `$TGT` when finished.

## 4. Cut over (scenarios C, D)

1. Stop writers: scale the API, workers and PowerSync services to zero.

   ```sh
   for s in api worker powersync; do
     aws ecs update-service --cluster harbour-prod --service "$s" --desired-count 0
   done
   ```

2. Run the verification checks in section 6 against `$TGT`.
3. Re-apply the retention shredding log so that records destroyed after the restore point stay destroyed ([retention-and-deletion.md](../compliance/retention-and-deletion.md)).
4. Swap identifiers so the endpoint name used by the application is unchanged:

   ```sh
   export FAILED="$SRC-failed-$(date -u +%Y%m%d%H%M)"
   # Skip the first rename if the source instance no longer exists
   aws rds modify-db-instance --db-instance-identifier "$SRC" \
     --new-db-instance-identifier "$FAILED" --apply-immediately
   aws rds wait db-instance-available --db-instance-identifier "$FAILED"
   aws rds modify-db-instance --db-instance-identifier "$TGT" \
     --new-db-instance-identifier "$SRC" --apply-immediately
   aws rds wait db-instance-available --db-instance-identifier "$SRC"
   ```

   Then reconcile Terraform state (`tofu import` or `terraform import`) so the next plan does not replace the instance. Keep the failed instance (deletion protection on) until the incident review closes; it is evidence.
5. Re-initialise PowerSync: its replication slot and positions belong to the old instance. Follow the [PowerSync self-hosting documentation](https://docs.powersync.com/self-hosting/getting-started) to clear bucket storage and re-replicate; devices then perform a full resync.
6. Start the API and workers, then PowerSync; restore desired counts from Terraform.
7. Run the smoke checks (section 6) and watch sync, upload rejection and error-rate dashboards for 30 minutes.

## 5. Files (S3)

Documents and photos are versioned. To recover an object, restore the previous version (`aws s3api list-object-versions`, then copy the version over the current object). Objects deleted by cryptographic shredding are intentionally unrecoverable.

## 6. Verification checks

Run as the database owner role against the restored instance. Expected results are in the comments. Table and column names follow `packages/db`.

```sql
-- 1. Every table with a tenant_id column has RLS enabled AND forced (expect zero rows; hazard HZ-011)
select n.nspname, c.relname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and (not c.relrowsecurity or not c.relforcerowsecurity);

-- 2. The application role is not a superuser, cannot bypass RLS and owns no tables (expect f, f, 0)
select rolsuper, rolbypassrls from pg_roles where rolname = '<app role from packages/db>';
select count(*) from pg_tables where tableowner = '<app role from packages/db>';

-- 3. pgAudit loaded and logical replication enabled for PowerSync
show shared_preload_libraries;   -- includes pgaudit
show wal_level;                  -- logical

-- 4. The audit table still has no UPDATE or DELETE grant for the application role (expect zero rows)
select privilege_type from information_schema.role_table_grants
where table_name = 'audit_event' and grantee = '<app role from packages/db>'
  and privilege_type in ('UPDATE', 'DELETE');

-- 5. Data reaches the expected point in time
select max(<created timestamp column>) from audit_event;
```

Then run the application checks: the RLS isolation test suite against the restored instance (`pnpm test:db` with the connection pointed at it, in the drill environment only), API health, sign-in, person list, and a sync from a test device.

## 7. Recording the restore

Record in the incident: scenario, restore point, commands run, timings (declared, restore started, instance available, verified, service restored), achieved RPO and RTO, data gap window and tenant actions, and deviations from this runbook. Update this runbook if any step was wrong.

## 8. Quarterly drill log

Drills run in an isolated account or the staging environment against a copy of the latest production snapshot (or staging before production exists), timed end to end, including the section 6 checks and a PowerSync re-initialisation.

| Date | Environment | Scenario | Restore point | Instance available after | Verified and serving after | RPO achieved | RTO achieved | Issues and runbook changes | Performed by |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `[first drill when staging exists]` | staging | C (PITR, latest restorable time) | | | | | | | |
