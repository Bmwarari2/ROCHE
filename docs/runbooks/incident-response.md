# Incident response

| Item | Value |
| --- | --- |
| Scope | Service incidents (outage, degradation, sync failure, data integrity), security incidents, and incidents with clinical impact. Personal data breaches also follow [../compliance/breach-response.md](../compliance/breach-response.md), which owns the 72-hour ICO clock and processor-to-controller notification |
| Status | Draft, Phase 0 |
| Related | [on-call.md](on-call.md), [restore.md](restore.md), [hazard log](../clinical-safety/hazard-log.md) |

## 1. Principles

1. The safety of people receiving care comes first. If staff cannot see or record care reliably, tell tenants quickly so they switch to their downtime procedure (printed downtime pack, paper records), even before the cause is known.
2. The mobile app's offline mode is the business-continuity path: devices keep working without the server. Do not force devices to sign out or resync during an incident unless that is the fix.
3. Contain first, then investigate. Preserve evidence before changing systems in a security incident.
4. Communicate early and on a fixed rhythm, in plain English, without personal data.
5. Every incident ends with a blameless review and actions.

## 2. Severity levels

| Level | Definition | Care-specific examples |
| --- | --- | --- |
| SEV1 Critical | Harbour unavailable or unsafe for many tenants; confirmed or likely cross-tenant exposure; data loss or corruption in care or medicines records; active security compromise | API down; sync stopped for all devices; records written to the wrong tenant or person; restore needed |
| SEV2 Major | Major function unavailable or degraded for one or more tenants with a workaround; risk to care if prolonged; suspected breach under investigation | eMAR rounds failing to save for a tenant; escalation or notification-clock jobs not firing; sync delayed beyond the stale threshold for many devices |
| SEV3 Minor | Partial degradation, no risk to care, workaround available | Slow reports; one integration failing; email delays |
| SEV4 Low | Cosmetic or single-user issue | Layout problem; typo |

Raise severity at once if clinical impact or a breach becomes possible; never lower it without the incident commander's decision.

## 3. Roles

| Role | Responsibility |
| --- | --- |
| Incident commander (IC) | Owns the incident: severity, decisions, roles, timeline. Primary on-call until handed over |
| Operations lead | Investigates and fixes; one person changes production at a time |
| Communications lead | Status page, in-app banner, tenant emails, regulator liaison with the DPO lead |
| Scribe | Timeline in the incident record (UTC times) |
| CSO | Clinical impact assessment and advice to tenants on care actions; hazard log update |
| DPO lead | Breach assessment and notifications ([breach-response.md](../compliance/breach-response.md)) |

For SEV3 and SEV4 the IC may hold every role.

## 4. Process

| Step | Actions |
| --- | --- |
| 1. Detect | Alert, synthetic check, support ticket, tenant call, security report |
| 2. Declare | Open an incident record (ID, severity, IC, start time in UTC); open the incident channel |
| 3. Triage | What is affected, which tenants, since when, is care at risk, could personal data be affected. If yes to care risk, page the CSO; if yes to data, page the DPO lead and tag `possible breach` |
| 4. Communicate | First update within the target in [on-call.md](on-call.md#2-response-targets); then every 30 minutes (SEV1) or 60 minutes (SEV2) until resolved |
| 5. Mitigate | Roll back the release; disable the feature flag; scale; fail over; block the attack path. For data integrity, stop writes to the affected area before repairing |
| 6. Resolve | Service restored and verified with the checks that detected it; devices syncing; queues drained |
| 7. Recover data if needed | [restore.md](restore.md); note that writes acknowledged after a restore point need a recovery plan |
| 8. Review | Post-incident review within 5 working days for SEV1 and SEV2, 10 for SEV3 |

## 5. Security incidents: additional steps

| Step | Action |
| --- | --- |
| Preserve evidence | Snapshot affected volumes and the database; export relevant CloudTrail, WAF, load balancer and application logs to a restricted evidence bucket before rotating or rebuilding |
| Contain | Revoke sessions and tokens, rotate secrets and keys (Secrets Manager, JWT signing keys, KMS grants), block IPs at the WAF, isolate compromised tasks, disable compromised accounts |
| Scope | Use `audit_event`, pgAudit and access logs to establish what was accessed, by whom, for which tenants |
| Eradicate and recover | Patch, rebuild from known-good images, restore data if altered |
| Notify | Breach procedure if personal data is involved; consider reporting to the NCSC and Action Fraud; insurer `[policy details - human action]` |
| Evidence for certifications | Keep the record for ISO 27001 and DSPT evidence |

## 6. Communication with tenants

| Channel | Use |
| --- | --- |
| Status page | All SEV1 and SEV2, and tenant-visible SEV3. No tenant names or personal data |
| In-app banner | Shown to affected tenants' users; for care-affecting incidents, tells staff to use the downtime procedure |
| Email to tenant Owners, Registered Managers and DPOs | SEV1 and SEV2 at declaration, at each material change and at resolution |
| Breach notice (in-app and email) | Only through [breach-response.md](../compliance/breach-response.md) |
| Field safety notice | When the CSO decides an issue needs specific actions by tenants (for example "re-check doses recorded between 02:00 and 03:00") |

**Templates** (plain English, no personal data):

- Declared: "We are investigating a problem affecting [what]. Since [time] staff may [impact]. If you cannot record care, use your downtime procedure. Next update by [time]."
- Update: "We have found [cause in plain words] and are [action]. [Impact now]. Next update by [time]."
- Resolved: "The problem affecting [what] was fixed at [time]. [What staff should check, for example records made offline will sync automatically]. We will share a summary of what happened and what we are changing within [5] working days."

## 7. Clinical impact checklist (CSO)

- Could any record have been lost, duplicated, shown to the wrong person, or shown out of date? Over what period?
- Which hazards are involved (for example HZ-002, HZ-004, HZ-006, HZ-011)? Does the hazard log likelihood need re-rating?
- What should tenants check or do (re-check MAR for a time window, confirm allergies, review incidents recorded offline)?
- Is a field safety notice needed? Does the safety case need a delta?

## 8. Post-incident review

Blameless, written in the incident record within the target: summary, impact (tenants, users, duration, data, care), timeline (UTC), root cause and contributing factors, what went well, what was hard, actions with owners and dates, hazard log and safety case changes, and whether tenants need a written summary (always for SEV1 and SEV2).

## 9. Incident log

| ID | Date | Severity | Summary | Tenants affected | Breach? | Clinical impact? | Review link |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |
