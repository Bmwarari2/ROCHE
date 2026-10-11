# DCB0160 deployment safety assessment: template for Harbour tenants

**Who this is for**: the care provider deploying Harbour (the tenant). Under DCB0160 the deploying organisation is responsible for the clinical safety of how a health IT system is deployed and used in its services. Thapsus, as manufacturer, meets DCB0129 and gives you the evidence below; this template helps you record your own assessment. Guidance on how the two standards fit together: [NHS England digital clinical safety assurance](https://www.england.nhs.uk/long-read/digital-clinical-safety-assurance/).

**How to use it**: Harbour pre-fills the fields marked *(pre-filled)* from your tenant configuration. Your Clinical Safety Officer (or named clinical lead) completes the rest, signs section 11 and uploads the signed copy in Harbour (Settings, Governance). Your tenant does not go live until this is recorded ([tenant onboarding](../runbooks/tenant-onboarding.md)).

Use the same 5 x 5 risk matrix as Thapsus (severity x likelihood, levels 1 to 5), set out in the [clinical risk management plan](clinical-risk-management-plan.md), section 3.2, so that your ratings and ours compare directly.

---

## 1. Deployment details

| Field | Value |
| --- | --- |
| Provider legal name | *(pre-filled)* |
| CQC provider ID | *(pre-filled)* |
| Locations in scope (name, CQC location ID, ODS code) | *(pre-filled)* |
| Service types | *(pre-filled: residential, nursing, domiciliary, supported living, ...)* |
| Harbour modules enabled | *(pre-filled)* |
| Harbour release and its safety case report version | *(pre-filled)* |
| Device modes in use | *(pre-filled: personal devices, shared devices, kiosk tablets)* |
| Planned go-live date | |
| Replacing | Paper records / another system (name) / new service |

## 2. Roles

| Role | Name | Contact |
| --- | --- | --- |
| Top management (for example Nominated Individual) | | |
| Clinical Safety Officer for this deployment. DCB0160 expects a suitably qualified and experienced clinician with current professional registration; if you have none, take advice before go-live | | |
| Registered Manager for each location | | |
| Deployment project lead | | |
| Data protection lead or DPO | *(pre-filled if recorded)* | |
| Caldicott Guardian | *(pre-filled if recorded)* | |

## 3. Scope

Describe which services, staff groups and workflows will use Harbour, and which stay on paper or another system for now. Note any interfaces (pharmacy, GP, council portal).

## 4. Manufacturer evidence received

| Item | Received (date) | Reviewed by |
| --- | --- | --- |
| Harbour clinical safety case report for the release, signed by Thapsus's CSO | | |
| Hazard log extract for the enabled modules | | |
| Release notes with the "clinical safety changes" section | | |
| Medical-device boundary statement | | |
| User guides and training material for each role | | |
| Data protection impact assessment, pre-filled ([DPIA template](../compliance/dpia-template.md)) | | |

## 5. Manufacturer hazards that depend on your controls

Thapsus has assessed these hazards. Their residual risk assumes the deployer controls below. For each, record what you have in place and your local rating.

| Hazard | Deployer control Thapsus assumes | Your arrangement | Local residual (S / L / R) |
| --- | --- | --- | --- |
| HZ-001 Wrong-person record selection | Photos taken at admission and kept current; staff check photo and date of birth before every administration and entry | | |
| HZ-002 Stale offline data shown as current | Critical changes (allergy, medicine stopped, resuscitation decision) also handed over verbally; downtime pack kept where connectivity is poor; staff know the sync banner states | | |
| HZ-003 Missed medication administration | Policy for time-critical medicines; every person allocated to a staff member for each round; eMAR competency current | | |
| HZ-004 Duplicated medication administration | One staff member per person per round; nurse in charge reviews sync conflicts each shift | | |
| HZ-005 Unit or dose transcription error | Second-person check of every new or changed MAR entry; source documents kept | | |
| HZ-006 Silent sync failure | Staff confirm no queued changes before leaving; devices charged and connected at handover; managers act on the "devices not synced" list | | |
| HZ-007 Incorrect or missing allergy display | Allergy status recorded at admission and at every medicines reconciliation | | |
| HZ-008 Alert fatigue | Managers review the monthly alert report and tune thresholds within the allowed bounds | | |
| HZ-009 Time-zone and daylight-saving errors | Location time zone correct; staff briefed before each clock change | | |
| HZ-010 Device clock drift | Automatic network time enforced on devices (MDM on shared devices); staff do not change device time | | |
| HZ-011 Cross-tenant or out-of-scope exposure | Least-privilege role design; periodic access review; leavers removed the same day; MDM on shared devices ([kiosk.md](../compliance/kiosk.md)) | | |
| HZ-012 Validated tool calculated incorrectly | Escalation policy for NEWS2, MUST and Waterlow results linked in configuration; clinicians record SpO2 Scale 2 decisions | | |
| HZ-013 Statutory notification missed or late | Notifications policy; acting-up grants for Registered Manager absences; weekly review of open notification decisions | | |

## 6. Local hazards

Hazards arising from your own deployment. Examples to consider:

| ID | Hazard | Causes | Effects | Initial (S / L / R) | Controls | Residual (S / L / R) | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L-001 | Records split between paper and Harbour during cutover | Parallel running; staff unsure which is current | Missed or duplicated care | | | | |
| L-002 | MAR migration error at go-live | Manual re-entry of current MARs | Wrong dose (see HZ-005) | | | | |
| L-003 | Not enough working devices on a shift | Breakage, charging, loss | Delayed recording; paper fallback | | | | |
| L-004 | Poor connectivity areas not known | No connectivity survey | Stale data (see HZ-002) | | | | |
| L-005 | Agency staff unfamiliar with Harbour | No induction | Use errors | | | | |
| L-... | | | | | | | |

## 7. Configuration decisions with safety relevance

| Setting | Harbour default | Your setting | Reason if changed |
| --- | --- | --- | --- |
| Auto-lock on shared and kiosk devices | 30 seconds (range 30 seconds to 2 minutes) | | |
| Auto-lock on personal devices | 2 minutes | | |
| Controlled-drug witness | On in residential and nursing; lone worker records "no witness available" with reason | | |
| Offline window on devices | 7 days | | |
| Stale-data warning threshold | *(pre-filled)* | | |
| Time-critical medicines list and windows | *(pre-filled)* | | |
| Escalation policy documents linked to NEWS2, MUST and Waterlow | None until you link them | | |
| Holders of `safety.notification.submit` | Registered Manager and Nominated Individual | | |
| Quiet hours and escalation chains | *(pre-filled)* | | |

## 8. Training plan

| Staff group | Training | Delivered by | Date | Competency recorded |
| --- | --- | --- | --- | --- |
| Care and support workers | | | | |
| Nurses and team leaders | | | | |
| Managers | | | | |
| Agency and bank staff | | | | |

## 9. Go-live and cutover

- Data migration: who checks imported people, allergies, medicines and care plans against source, and when.
- Parallel running period (if any) and the rule for which record is authoritative.
- Downtime procedure: where the printed downtime pack is kept and who prints it.
- Rollback criteria and plan.

## 10. Post-deployment monitoring

- Report safety issues with Harbour to Thapsus through in-app support using the "Safety" category; Thapsus's CSO responds.
- Review this assessment when a Harbour release note lists clinical safety changes, when you enable a new module or service type, after any incident involving Harbour, and at least every 12 months.

## 11. Deployment clinical safety case summary and sign-off

**Claim**: the deployment of Harbour at the locations in section 1 is acceptably safe, given the manufacturer's evidence (section 4), the deployer controls (section 5) and the local controls (section 6).

| Outstanding risks at level 3 or above and why they are accepted |
| --- |
| |

| Role | Name | Registration (CSO) | Date | Signature |
| --- | --- | --- | --- | --- |
| Clinical Safety Officer | | | | |
| Top management | | Not applicable | | |
