# On-call

| Item | Value |
| --- | --- |
| Status | Draft, Phase 0. During the build only `dev` and `staging` exist and on-call is best-effort. A 24/7 rota is in place before the first live tenant `[human action]` |
| Why 24/7 | Care happens around the clock; a night-shift eMAR round or a missed-visit alarm cannot wait for office hours |
| Related | [incident-response.md](incident-response.md), [restore.md](restore.md), [../compliance/breach-response.md](../compliance/breach-response.md) |

## 1. Rota and escalation

| Role | Who | Responsibility |
| --- | --- | --- |
| Primary on-call | `[rota - human action]` | Acknowledge pages, triage, act as incident commander until handed over |
| Secondary on-call | `[rota - human action]` | Backup if primary does not acknowledge; second pair of hands for SEV1 and SEV2 |
| Engineering lead | `[name - human action]` | Escalation for SEV1, for decisions to restore or roll back, and for any security incident |
| Clinical Safety Officer | `[CSO name - human action]` | Called for any incident that could affect care (records unavailable, wrong or missing data, sync failure at scale, medicines or notification faults) |
| DPO or named lead | `[name - human action]` | Called for any incident that may be a personal data breach |
| Thapsus director | Brian | SEV1 and any incident requiring tenant-wide or regulator communication |

Hand-over happens at a fixed weekly time, with open incidents, recent changes and known risks written in the on-call channel.

## 2. Response targets

| Severity ([definitions](incident-response.md#2-severity-levels)) | Acknowledge | Incident commander engaged | First tenant update |
| --- | --- | --- | --- |
| SEV1 | 5 minutes | 15 minutes | 30 minutes |
| SEV2 | 15 minutes | 30 minutes | 1 hour |
| SEV3 | 1 hour (working hours) | Same working day | If tenant-visible, same working day |
| SEV4 | Next working day | Not required | Release notes |

## 3. Alerts that page

Alerts are defined as code with the infrastructure and route through Grafana Cloud alerting `[paging integration to choose - human action]`.

| Alert | Why it matters | First action |
| --- | --- | --- |
| API error rate or latency above threshold; synthetic sign-in or person-list check failing | Staff cannot use Harbour | Check recent deploys, roll back if correlated |
| PowerSync service unhealthy or replication lag above threshold | Devices stop receiving changes (hazards HZ-002, HZ-006) | Check the service, the replication slot and the bucket-storage database |
| Upload rejection rate or upload queue age above threshold across devices | Records may not be reaching the server (HZ-006) | Check API upload handlers, schema version mismatch after a release |
| Device clock-drift flags above baseline | Recorded times may be wrong (HZ-010) | Check server time; check whether one tenant's MDM changed |
| pg-boss queue age, failed jobs, or escalation jobs not firing | Reminders, escalations and notification clocks may be late (HZ-003, HZ-013) | Inspect failing job type; replay idempotent jobs |
| `worker.job.failed` log line (the worker's structured JSON: `queue`, `error` (the error's kind), `code` (a database code, or null), and `tenantId` when one organisation's part of a sweep failed). Cloud Monitoring alert `<prefix>-worker-job-failed` on a log-based metric (filter `jsonPayload.event = "worker.job.failed"`): one or more in 15 minutes, defined in Terraform, live once applied (H-171). The AWS `infra/modules/observability` module that held it is being rewritten for Google Cloud ([ADR-0098](../decisions/0098-production-on-google-cloud.md)) | A job failed and pg-boss retries it, or one organisation's part of a sweep failed while the rest ran on: reminders, escalations, handovers and notification clocks may be late (HZ-003, HZ-008, HZ-013, HZ-018; ADR-0071 review round 5) | Read the queue, code and tenant id from the line (opaque ids only); for a tenant, the matching `platform.job.tenant_failed` audit event names the job. Fix the cause and check the next run succeeds |
| `worker.job.failed` with queue `downtime-packs` (`tenantId`, `locationId` when one location's pack failed, `code`). Cloud Monitoring alert `<prefix>-downtime-pack-failed` on a log-based metric (filter `jsonPayload.event = "worker.job.failed" AND jsonPayload.queue = "downtime-packs"`): any one line in an hour, defined in Terraform (`infra/modules/observability`), live once applied (H-171); with Grafana Cloud the same alert goes to on-call (H-12) | A location's nightly downtime pack could not be built: if it keeps failing, the location has no pack in date for an outage (HZ-021). The location's Registered Manager is also given `operations.downtime_pack_missing` once no pack is in date (operations.md rule 8) | The same working day: read the tenant and location ids and the code (opaque ids only), fix the cause, then build the pack again (the worker's hourly catch-up, or `rebuildLocation`), and check a pack is in date for that location. If it cannot be fixed that day, tell the organisation so the nurse in charge prints the last pack in date and keeps it where the business continuity plan says (recommended answer to H-214) |
| `worker.job.failed` with queue `document-destruction` (`tenantId`, `outboxEventId`, `code`: the object store's error code for an object it would not delete, such as `403` from Cloud Storage (ADR-0098), or `VersionsRemain` when a version was still listed after the delete). Same alarm as the row above | A document destroyed past retention has its tombstone and destruction certificate, but its stored bytes could not be deleted (PLAT-012): personal data is kept past its retention period until the retry succeeds. The outbox retries with back-off up to every hour | Check the worker's access to the documents bucket (list versions and delete) and the storage's health. Pending deletions are the unpublished `platform.document.destroyed` outbox events (`SELECT tenant_id, aggregate_id, attempts, last_error FROM outbox_event WHERE event_type = 'platform.document.destroyed' AND published_at IS NULL`; opaque ids only). Once fixed, set their `available_at` to now to retry at once, and check each is published |
| `security.export.foreign_rows` log line (`tenantId`, `exportId` only). Cloud Monitoring alert `<prefix>-export-foreign-rows` on a log-based metric (filter `jsonPayload.event = "security.export.foreign_rows"`): any line in 5 minutes | A full export met a row of another organisation: row-level security failed somewhere (HZ-070, HZ-011). The export was failed and never offered | SEV1 security incident: keep the failed export's record and audit trail, find the table from the export's `problems` (`foreign_tenant_rows`), check its policies, and follow the security incident runbook |
| `platform.job.tenant_failed` audit events (one organisation's part of a worker sweep failed: handovers, care plan rounds, reminders, escalations, the daily unrouted report; the job name and error code are in the event's scope) | That organisation's handovers, rounds or alerts may be missing while every other organisation's run on (HZ-018, HZ-008). Alerted through the `worker.job.failed` line written with each (review round 5) | Read the job and code from the event (opaque ids only), fix the cause, and check the next sweep for that tenant succeeds |
| `escalation.unrouted.daily` log line (once a day, from the worker's `unrouted-daily-report` job, counting the last 25 hours; fields `tenantId` and `counts` per audit action: `task.escalation_unrouted`, `sync.escalation_unrouted`, `platform.escalation.unrouted`, `care.refused_entry.unrouted`, `care.alert.unrouted`, `people.break_glass_alert.unrouted`, `safety.notification.unrouted`; one line per organisation with any, none for the rest). Cloud Monitoring alert `<prefix>-escalation-unrouted` on a log-based metric (filter `jsonPayload.event = "escalation.unrouted.daily"`): any line, over a one-hour period so the alert clears within the hour and every daily run with a line notifies again (one organisation unrouted for weeks never hides another), defined in Terraform, live once applied (H-171) | Safety work in that organisation reached no one who could act, or only the person it was given to or who caused it: an overdue task, an escalation step, an urgent review or alert, a break-glass alert or an overdue statutory notification no active member of staff can submit (HZ-008, HZ-013, HZ-073; ADR-0071 review rounds 4 and 5) | The same working day, tell the organisation's Registered Manager or owner, by opaque ids only, that safety work is reaching no one: usually no team leader, clinical lead or Registered Manager is active at a home, or a role has ended. Until H-170 is decided this is the only signal outside the audit |
| Notification delivery failure rate (email, push, SMS) | Alerts may not reach staff | Check provider status; fail over channel where configured |
| Cloud SQL: storage, CPU, connections, failover event, backup failure | Data at risk | Follow [restore.md](restore.md) if data is affected |
| `audit_event` insert failures | Records must be attributable | Treat as SEV2; audit writes are in the same transaction as the change |
| RLS catalogue check failing (scheduled job), unexpected cross-tenant query errors | Possible isolation failure (HZ-011) | Treat as SEV1 security incident |
| Cloud Armor anomaly, authentication failure spike, impossible-travel sign-ins | Possible attack | Security incident procedure |
| TLS certificate or signing key near expiry | Outage risk | Rotate |

## 4. Access during an incident

- Production access is through Google Cloud sign-in with MFA and a time-limited IAM grant in the prod project; every session is in Cloud Audit Logs. There are no long-lived cloud keys or service account keys.
- No one reads tenant care records during an incident unless needed to resolve it. Support impersonation needs the tenant's approval ticket and is visible to the tenant in its audit log (master prompt 4).
- Database access uses a read-only role by default; any write needs a second engineer's agreement and is done through an audited, reviewed script.
- Never paste personal data into chat, tickets, Sentry comments or post-incident reviews. Use opaque IDs.

## 5. Before you go on call

- [ ] You can sign in to Google Cloud (production read-only access), Grafana Cloud, Sentry and the status page.
- [ ] You have read [incident-response.md](incident-response.md), [restore.md](restore.md) and the breach clocks in [breach-response.md](../compliance/breach-response.md).
- [ ] You know how to reach the CSO and the DPO lead out of hours.
- [ ] Your phone receives test pages.
