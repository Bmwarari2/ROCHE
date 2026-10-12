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
| `worker.job.failed` log line (the worker's structured JSON: `queue`, `error` (the error's kind), `code` (a database code, or null), and `tenantId` when one organisation's part of a sweep failed). CloudWatch alarm `<prefix>-worker-job-failed`: one or more in 15 minutes, defined in Terraform (`infra/modules/observability`, metric filter `{ $.event = "worker.job.failed" }`), live once applied (H-171) | A job failed and pg-boss retries it, or one organisation's part of a sweep failed while the rest ran on: reminders, escalations, handovers and notification clocks may be late (HZ-003, HZ-008, HZ-013, HZ-018; ADR-0071 review round 5) | Read the queue, code and tenant id from the line (opaque ids only); for a tenant, the matching `platform.job.tenant_failed` audit event names the job. Fix the cause and check the next run succeeds |
| `platform.job.tenant_failed` audit events (one organisation's part of a worker sweep failed: handovers, care plan rounds, reminders, escalations, the daily unrouted report; the job name and error code are in the event's scope) | That organisation's handovers, rounds or alerts may be missing while every other organisation's run on (HZ-018, HZ-008). Alerted through the `worker.job.failed` line written with each (review round 5) | Read the job and code from the event (opaque ids only), fix the cause, and check the next sweep for that tenant succeeds |
| `escalation.unrouted.daily` log line (once a day, from the worker's `unrouted-daily-report` job, counting the last 25 hours; fields `tenantId` and `counts` per audit action: `task.escalation_unrouted`, `sync.escalation_unrouted`, `platform.escalation.unrouted`, `care.refused_entry.unrouted`, `care.alert.unrouted`, `people.break_glass_alert.unrouted`, `safety.notification.unrouted`; one line per organisation with any, none for the rest). CloudWatch alarm `<prefix>-escalation-unrouted`: any line in a day, defined in Terraform (`infra/modules/observability`, metric filter `{ $.event = "escalation.unrouted.daily" }`), live once applied (H-171) | Safety work in that organisation reached no one who could act, or only the person it was given to or who caused it: an overdue task, an escalation step, an urgent review or alert, a break-glass alert or an overdue statutory notification no active member of staff can submit (HZ-008, HZ-013, HZ-073; ADR-0071 review rounds 4 and 5) | The same working day, tell the organisation's Registered Manager or owner, by opaque ids only, that safety work is reaching no one: usually no team leader, clinical lead or Registered Manager is active at a home, or a role has ended. Until H-170 is decided this is the only signal outside the audit |
| Notification delivery failure rate (email, push, SMS) | Alerts may not reach staff | Check provider status; fail over channel where configured |
| RDS: storage, CPU, connections, failover event, backup failure | Data at risk | Follow [restore.md](restore.md) if data is affected |
| `audit_event` insert failures | Records must be attributable | Treat as SEV2; audit writes are in the same transaction as the change |
| RLS catalogue check failing (scheduled job), unexpected cross-tenant query errors | Possible isolation failure (HZ-011) | Treat as SEV1 security incident |
| WAF anomaly, authentication failure spike, impossible-travel sign-ins | Possible attack | Security incident procedure |
| TLS certificate or signing key near expiry | Outage risk | Rotate |

## 4. Access during an incident

- Production access is through AWS SSO with MFA into a time-limited role; every session is logged. There are no long-lived cloud keys.
- No one reads tenant care records during an incident unless needed to resolve it. Support impersonation needs the tenant's approval ticket and is visible to the tenant in its audit log (master prompt 4).
- Database access uses a read-only role by default; any write needs a second engineer's agreement and is done through an audited, reviewed script.
- Never paste personal data into chat, tickets, Sentry comments or post-incident reviews. Use opaque IDs.

## 5. Before you go on call

- [ ] You can sign in to AWS (production read-only role), Grafana Cloud, Sentry and the status page.
- [ ] You have read [incident-response.md](incident-response.md), [restore.md](restore.md) and the breach clocks in [breach-response.md](../compliance/breach-response.md).
- [ ] You know how to reach the CSO and the DPO lead out of hours.
- [ ] Your phone receives test pages.
