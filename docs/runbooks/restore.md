# Database restore

| Item | Value |
| --- | --- |
| Objectives | **RPO 15 minutes**, **RTO 4 hours** (master prompt 7) |
| Platform | Cloud SQL for PostgreSQL 17 in Google Cloud europe-west2 ([ADR-0098](../decisions/0098-production-on-google-cloud.md)) |
| Backups | Cloud SQL automated daily backups with point-in-time recovery (PITR) from transaction logs; on-demand backup before every production migration; object versioning on document buckets |
| Disaster recovery stance | Google Cloud has no second UK region, so recovery is regional high availability plus PITR, and the mobile app's offline mode is the business-continuity path (ADR-0001, ADR-0098) |
| Drill | Before go-live and quarterly, logged in section 8 |
| Status | Draft. Resource names below follow the Google Cloud plan in `infra/README.md`; the Terraform modules in `infra/` still target AWS until they are rewritten, so confirm every name and command against the environment before use |

## 1. Choose the scenario

| Scenario | Use |
| --- | --- |
| A. Zone or instance failure | No restore. Cloud SQL regional high availability fails over to the standby in the second London zone automatically (typically within minutes). Verify with the checks in section 6 |
| B. Bad change affecting part of the data (bad migration, faulty job, one tenant's data damaged) | Restore to a **new** instance at a point before the change, extract the affected rows, and repair production through an audited script. Do not roll the whole database back for one tenant |
| C. Database lost or corrupted as a whole | PITR to a new instance at the latest safe time, then switch the connection (sections 3 to 5) |
| D. Need a point older than PITR allows, or a pre-migration state | Restore a named backup to a new instance (section 3.2) |
| E. Security compromise (data altered by an attacker) | Follow [incident-response.md](incident-response.md) section 5 first (preserve evidence), then B or C |

Declare an incident (SEV1 for C, D and E; at least SEV2 for B), page the CSO, and tell tenants to use their downtime procedure if staff cannot work ([incident-response.md](incident-response.md)).

## 2. Before restoring: the offline-device gap

Devices keep working offline and upload when they can. Writes that the API **acknowledged after the restore point** are no longer on the server after a restore, and the device has already removed them from its upload queue, so they will not be re-sent. On the next sync, devices replace their local copy with the restored server state.

1. Keep the API upload endpoints and PowerSync **stopped** until the gap is understood (section 4).
2. Establish the gap window: restore point to the time writes stopped.
3. From API access logs (Grafana Cloud, outside the database), list the tenants and devices that uploaded during the window.
4. With the CSO, tell those tenants which period to re-check (care notes, charts, administrations, incidents) and that staff must not re-give medicines based on the restored MAR without checking (hazards HZ-004 and HZ-006). Issue a field safety notice if the CSO decides.
5. Open an ADR action for an upload journal (accepted client mutations written to append-only storage in Cloud Storage) so that the gap can be replayed automatically in future `[engineering decision]`.

## 3. Restore the database

Cloud SQL always restores to a **new** instance here; the damaged instance is never overwritten, because it is evidence. Set variables (values from Terraform outputs):

```sh
export PROJECT=harbour-prod                    # the prod project
export REGION=europe-west2
export SRC=harbour-prod-main                   # source instance
export TGT=harbour-prod-main-$(date -u +%Y%m%d%H%M)
gcloud config set project "$PROJECT"
```

### 3.1 Point-in-time recovery (scenarios B, C)

```sh
# Restore to a chosen UTC time before the damaging change, as a new instance.
# The clone keeps the source's private network, flags (pgAudit, logical decoding) and CMEK key.
gcloud sql instances clone "$SRC" "$TGT" --point-in-time='2026-10-11T09:30:00.000Z'

# For scenario C, choose the latest safe time: the most recent transaction log upload is
# normally within minutes of now.

# Make the new instance match production before it takes traffic
gcloud sql instances patch "$TGT" --availability-type=REGIONAL --deletion-protection
gcloud sql instances describe "$TGT" --format='value(state,ipAddresses)'
```

The restored instance is encrypted with the same Cloud KMS key as the source and has a private IP only.

### 3.2 Backup restore (scenario D)

```sh
gcloud sql backups list --instance="$SRC"

# Create $TGT first with the same settings as $SRC (from Terraform, private IP only, CMEK, flags),
# then restore the chosen backup into it. Never restore over $SRC.
gcloud sql backups restore <backup-id> --restore-instance="$TGT" --backup-instance="$SRC"
```

### 3.3 Partial repair (scenario B)

Connect to `$TGT` with the read-only role, extract the affected tenant's rows for the affected tables (always filter by `tenant_id`), and write a repair script reviewed by a second engineer. Run it against production with the maintenance role. Corrections to append-only event tables are made as new correction events that reference the original, never as updates. Record the repair in the incident and in `audit_event`. Delete `$TGT` when finished (remove deletion protection first).

## 4. Switch the connection (scenarios C, D)

Cloud SQL instances cannot be renamed, so the application is pointed at the new instance instead.

1. Stop writers: put the load balancer's maintenance rule in front of the API and PowerSync, and bring the API, worker and PowerSync Cloud Run services to zero instances, so nothing writes to either instance.
2. Run the verification checks in section 6 against `$TGT`.
3. Re-apply the retention shredding log so that records destroyed after the restore point stay destroyed ([retention-and-deletion.md](../compliance/retention-and-deletion.md)).
4. Switch the connection: add a new version of each database URL secret in Secret Manager (`DATABASE_APP_URL`, `DATABASE_AUTH_URL`, `DATABASE_OPERATOR_URL`, `DATABASE_WORKER_URL` and PowerSync's replication URL) with the new instance's private IP, for example:

   ```sh
   gcloud secrets versions add DATABASE_APP_URL --location="$REGION" --data-file=-   # value on stdin
   ```

   Then point Terraform at `$TGT` (change the instance name input, or `terraform state rm` and `terraform import`) so the next plan does not replace or recreate it. Keep the failed instance (deletion protection on) until the incident review closes; it is evidence.
5. Re-initialise PowerSync: its replication slot and positions belong to the old instance. Follow the [PowerSync self-hosting documentation](https://docs.powersync.com/self-hosting/getting-started) to clear bucket storage and re-replicate; devices then perform a full resync.
6. Deploy new revisions of the API and worker so they read the new secret versions, then PowerSync; restore their minimum instances from Terraform and remove the maintenance rule.
7. Run the smoke checks (section 6) and watch sync, upload rejection and error-rate dashboards for 30 minutes.

## 5. Files (Cloud Storage)

Documents and photos are versioned. To recover an object, list its versions and copy the previous generation over the current object:

```sh
gcloud storage ls --all-versions gs://<documents-bucket>/<object-path>
gcloud storage cp gs://<documents-bucket>/<object-path>#<generation> gs://<documents-bucket>/<object-path>
```

Objects deleted by cryptographic shredding are intentionally unrecoverable.

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

-- 3. pgAudit on and logical decoding enabled for PowerSync (Cloud SQL flags)
select extname from pg_extension where extname = 'pgaudit';   -- one row
show wal_level;                                                -- logical

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

Drills run in an isolated project or the staging environment against a copy of the latest production snapshot (or staging before production exists), timed end to end, including the section 6 checks and a PowerSync re-initialisation.

| Date | Environment | Scenario | Restore point | Instance available after | Verified and serving after | RPO achieved | RTO achieved | Issues and runbook changes | Performed by |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `[first drill when staging exists]` | staging | C (PITR, latest restorable time) | | | | | | | |
