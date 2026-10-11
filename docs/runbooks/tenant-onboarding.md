# Tenant onboarding

| Item | Value |
| --- | --- |
| Who runs it | Thapsus onboarding (operator console) with the tenant's Owner, Registered Managers and DPO |
| Outcome | A tenant that is configured, trained, legally covered and clinically assessed, marked **live** in the operator console only when every go-live item in section 9 is complete |
| Status | Draft, Phase 0. Operator console screens arrive in Phase 1; until then steps are done with the seed and admin scripts in `packages/db` |

Items marked **Human action** cannot be done by the software and are recorded in the onboarding checklist with who did them and when.

## 1. Contract and data protection

| Step | Detail | Owner |
| --- | --- | --- |
| 1.1 | Main subscription agreement signed **Human action** | Brian, tenant Owner |
| 1.2 | Data processing agreement signed in-app ([template](../compliance/dpa-article-28-template.md)) **Human action** | Tenant Owner |
| 1.3 | Sub-processor register shown and acknowledged ([register](../compliance/sub-processors.md)) | Tenant DPO |
| 1.4 | Tenant's ICO registration number recorded | Tenant |

## 2. Provision the tenant

| Step | Detail |
| --- | --- |
| 2.1 | Create the tenant in the operator console: legal name, legal form (company, charity, franchise, public body), CQC provider ID, nation, VAT status, group membership if any |
| 2.2 | Sector flag (independent or public body): selects the lawful-basis column in the records of processing ([records-of-processing.md](../compliance/records-of-processing.md)) |
| 2.3 | White-label name, logo and accent (accent auto-adjusted to at least 4.5:1 contrast) |
| 2.4 | Modules enabled by feature flag; AI stays off (it needs the DPIA AI addendum first) |
| 2.5 | Retention overrides, only within the schedule's minimums ([../specs/retention.md](../specs/retention.md)) |
| 2.6 | Confirm the tenant row exists, RLS isolation applies (run the tenant smoke check), and the first Owner invitation is sent |

## 3. Locations and services

| Step | Detail |
| --- | --- |
| 3.1 | For each location: name, address, CQC location ID, ODS code, regulator, nation, time zone (Europe/London for England and Wales) |
| 3.2 | Services and service types (residential, nursing, supported living, domiciliary, complex care at home, live-in, respite, day service); these drive which modules and templates are active |
| 3.3 | Shift pattern per location (used for shared-device sign-out until the rota module is live) |

## 4. Governance roles

| Role | Recorded in Harbour |
| --- | --- |
| Owner(s), Nominated Individual | Yes |
| Registered Manager per location | Yes |
| DPO or data protection lead, Caldicott Guardian, SIRO | Yes (master prompt 5.1) |
| Clinical Safety Officer or named clinical lead for DCB0160 | Yes |
| Holders of `safety.notification.submit` (default: Registered Manager and Nominated Individual) | Yes |

## 5. Users, roles and MFA

| Step | Detail |
| --- | --- |
| 5.1 | Review built-in roles with the tenant; clone or rename only where needed (least privilege) |
| 5.2 | Invite users with role and scope (location, team, assigned people) |
| 5.3 | **MFA enrolment**: every user in a role that can read care records enrols a passkey or a TOTP app before they can open a care record. SMS is allowed only as a documented exception per user |
| 5.4 | Personal devices: users install the app and sign in once with full MFA, then set biometric or PIN unlock |
| 5.5 | Shared and kiosk devices: tenant's MDM enrols each device; a manager enrols it in Harbour; staff set their PINs ([kiosk.md](../compliance/kiosk.md)) **Human action** (tenant IT) |
| 5.6 | Check: MFA enrolment report shows 100% for care-record roles |

## 6. Data

| Step | Detail |
| --- | --- |
| 6.1 | Training: offer sample data mode with invented people (for example "Ada Example") so staff can practise. Sample data is clearly labelled and removed before go-live |
| 6.2 | Import: guided migration from spreadsheets or a previous system; dry run; validation report (including people without an allergy status and medicines not yet checked) |
| 6.3 | Tenant checks imported people, allergies, communication needs, contacts and (from Phase 2) medicines against the source and signs off the import **Human action** |
| 6.4 | Photos for every person receiving care taken or confirmed (hazard HZ-001) **Human action** |

## 7. DPIA and clinical safety

| Step | Detail | Owner |
| --- | --- | --- |
| 7.1 | DPIA generated pre-filled from configuration ([template](../compliance/dpia-template.md)); tenant completes and the DPO signs in-app **Human action** | Tenant DPO |
| 7.2 | Harbour's clinical safety case report for the release the tenant will run, **signed by Thapsus's CSO**, supplied with the hazard log extract **Human action** | Thapsus CSO |
| 7.3 | Tenant's DCB0160 assessment completed and signed ([template](../clinical-safety/dcb0160-deployment-template.md)) **Human action** | Tenant CSO or clinical lead |
| 7.4 | Safety-relevant configuration agreed (DCB0160 section 7): auto-lock times, controlled-drug witness, time-critical medicines, escalation policies linked to NEWS2, MUST and Waterlow | Tenant clinical lead |

## 8. Training

| Group | Content |
| --- | --- |
| Care and support workers | Signing in, the point-of-care header, writing notes offline, the sync banner and what to do when it warns, shared-device etiquette (never share a PIN) |
| Team leaders and nurses | As above plus handover, conflict review, escalation |
| Managers | Users and roles, device management, break-glass, reports, DSAR and complaint registers, downtime pack |
| Everyone | Downtime procedure and where the printed pack is kept |

Training completion recorded per user **Human action** (tenant).

## 9. Go-live checklist

The operator console marks the tenant live only when every item is ticked, with who and when.

| # | Item | Type |
| --- | --- | --- |
| 1 | Main agreement and DPA signed | Human action |
| 2 | DPIA signed by the tenant's DPO in-app | Human action |
| 3 | Thapsus clinical safety case report for this release signed by Thapsus's CSO | Human action |
| 4 | Tenant DCB0160 assessment signed and uploaded | Human action |
| 5 | Production release approved by Brian (master prompt 7) | Human action |
| 6 | MFA enrolment 100% for care-record roles | System check |
| 7 | Shared devices enrolled; lost-device process agreed | Human action and system check |
| 8 | Imported data checked and signed off; sample data removed | Human action and system check |
| 9 | Photos present for all active people (exceptions listed) | System check |
| 10 | Escalation policies linked; notification submitters set | System check |
| 11 | Downtime pack printing set up and a test pack printed | Human action |
| 12 | Training completion recorded for all go-live staff | Human action |
| 13 | Support contacts, status page subscription and the "Safety" reporting route shared | Thapsus |
| 14 | Go/no-go call held with Owner, Registered Manager and Thapsus | Human action |

## 10. After go-live

- Hypercare for 2 weeks: daily check-in, sync and error dashboards watched for the tenant.
- Review at 30 days: usage, devices not syncing, alert volumes (HZ-008), open support issues, any safety reports; update the DCB0160 assessment and DPIA if configuration changed.
