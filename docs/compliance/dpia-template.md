# Data protection impact assessment: Harbour deployment template

**For**: each tenant (care provider), as controller. **Required because** the processing involves special category data about people who may be vulnerable, on a large scale, using new technology including offline mobile devices; these match the ICO's criteria for when a DPIA is needed ([ICO: when do we need to do a DPIA?](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/); UK GDPR Art 35).

**How it works**: Harbour pre-fills this template from the tenant's configuration. Merge fields are shown as `{{field}}` and are filled from the tenant record; Harbour re-generates the pre-filled sections when configuration changes and flags the DPIA for review. The tenant's DPO or named lead completes the remaining sections and **signs it in-app before go-live** (master prompt 5.1); the signer cannot be one of the people who prepared that version, and a risk still high after its measures needs the ICO's prior consultation reference first. A signed DPIA falls due for review when a purpose, sub-processor, data category or module appears that it did not cover, and yearly. Enabling the AI module requires the AI addendum (section 9) to be signed first (master prompt 16); the family portal and marketing add sections 10 and 11. Rules: [platform-completions.md](../specs/platform-completions.md) rules 17 to 22, `packages/domain/src/platform/dpia.ts`.

---

## 1. Identification

| Field | Value |
| --- | --- |
| Controller | `{{tenant.legalName}}` |
| CQC provider ID | `{{tenant.cqcProviderId}}` |
| DPO or named lead | `{{tenant.dpo.name}}`, `{{tenant.dpo.email}}` |
| Caldicott Guardian | `{{tenant.caldicottGuardian.name}}` |
| SIRO | `{{tenant.siro.name}}` |
| Processor | Thapsus Cargo Ltd (Harbour), under the data processing agreement signed `{{tenant.dpa.signedOn}}` |
| DPIA version and date | `{{dpia.version}}`, `{{dpia.generatedOn}}` |

## 2. Need for a DPIA (screening)

| Criterion | Applies? |
| --- | --- |
| Special category data (health, social care) on a large scale | Yes |
| Data about vulnerable people (including people who may lack capacity) | Yes |
| New technology (offline mobile records, shared devices) | Yes |
| Systematic monitoring (electronic call monitoring with location in home care) | `{{modules.domiciliary.enabled ? "Yes" : "No"}}` |
| AI processing | `{{modules.ai.enabled ? "Yes: complete section 9" : "No"}}` |
| Children's data | `{{modules.childrensHomes.enabled ? "Yes" : "No"}}` |

## 3. Description of the processing

### 3.1 Nature

| Item | Pre-filled value |
| --- | --- |
| Locations | `{{locations[].name}}` (`{{locations[].cqcLocationId}}`) |
| Service types | `{{services[].type}}` |
| Modules enabled | `{{modules.enabled[]}}` |
| Device modes | `{{devices.modes[]}}` (personal, shared, kiosk) |
| Offline window on devices | `{{settings.offlineWindowDays}}` days |
| Sub-processors in use | From [sub-processors.md](sub-processors.md) for the enabled features: `{{subProcessors.inUse[]}}` |
| Retention schedule | `{{retention.scheduleVersion}}`, tenant overrides `{{retention.overrides[]}}` ([../specs/retention.md](../specs/retention.md)) |

How data is collected, stored, used, shared and deleted: staff record care at the point of care (often offline); records sync to Harbour's UK-hosted database; access is limited by role, location, team, assignment and time; external professionals and families get scoped access where the tenant allows; records are kept under the retention schedule and then cryptographically shredded ([retention-and-deletion.md](retention-and-deletion.md)).

### 3.2 Scope

| Item | Value |
| --- | --- |
| Approximate number of people receiving care | `{{stats.activePeople}}` |
| Approximate number of staff users | `{{stats.activeStaff}}` |
| Data categories | From the tenant's records of processing ([records-of-processing.md](records-of-processing.md), Part B) |
| Geography | UK hosting (AWS London). Exceptions: `{{subProcessors.outsideUk[]}}` |

### 3.3 Context

Relationship with the people concerned, their expectations, whether they can exercise control, people who lack capacity, and any prior concerns. *Tenant completes.*

### 3.4 Purposes

From the records of processing (Part B, purposes B1 to B10 that apply): `{{ropa.purposes[]}}`

## 4. Consultation

| Who | How consulted | Summary of views |
| --- | --- | --- |
| People receiving care and families (or representatives) | | |
| Staff and their representatives | | |
| Tenant DPO and Caldicott Guardian | | |
| Clinical lead or CSO (link to the [DCB0160 assessment](../clinical-safety/dcb0160-deployment-template.md)) | | |
| Thapsus (processor) | Security and processing information supplied in this pack | |

## 5. Necessity and proportionality

| Question | Pre-filled answer | Tenant comment |
| --- | --- | --- |
| Lawful basis and special category condition per purpose | From records of processing; consent never used for care records | |
| Does the processing achieve the purpose, and is there a less intrusive way? | Digital records support safer care, regulatory compliance and continuity; offline access is needed for care at the point of care | |
| Data minimisation | Devices hold only assigned people and the next `{{settings.offlineWindowDays}}` days; fields defined per module spec | |
| Accuracy | Corrections are new events referencing the original; stale writes become review tasks | |
| Retention | Schedule as above; legal holds; destruction certificates | |
| Information to individuals | Privacy notices (people receiving care, easy read, families, staff) published on `{{tenant.privacyNoticeUrl}}` | |
| Rights | DSAR workbench, rectification, restriction, portability, complaints route | |
| Processors and transfers | DPA signed; sub-processor register; transfers outside the UK listed above | |

## 6. Risks to individuals

Likelihood of harm: remote, possible, probable. Severity of harm: minimal, significant, severe. Overall: low, medium, high.

| ID | Risk | Likelihood | Severity | Overall |
| --- | --- | --- | --- | --- |
| R1 | Unauthorised access by staff outside their role or scope | Possible | Significant | Medium |
| R2 | Loss or theft of a device holding offline records | Possible | Significant | Medium |
| R3 | Exposure to another provider's users (cross-tenant) | Remote | Severe | Medium |
| R4 | Inaccurate or out-of-date records leading to wrong care (see hazard log HZ-002, HZ-006) | Possible | Severe | High |
| R5 | Records kept longer than necessary, or deleted too early | Possible | Significant | Medium |
| R6 | Sharing with families or professionals beyond what is agreed | Possible | Significant | Medium |
| R7 | Transfer outside the UK through a sub-processor | Remote | Significant | Low |
| R8 | Shared-device misuse (another user's session) | Possible | Significant | Medium |
| R9 | Location data from electronic call monitoring used beyond its purpose | `{{modules.domiciliary.enabled ? "Possible" : "Not applicable"}}` | Significant | |
| R10 | AI drafts relied on without review, prompt injection through notes, or disclosure to the provider | `{{modules.ai.enabled ? "Possible" : "Not applicable"}}` | Significant | Medium |
| R11 | A photo or update shared beyond the consent given | `{{modules.familyPortal.enabled ? "Possible" : "Not applicable"}}` | Significant | Medium |
| R12 | Marketing without valid consent | `{{settings.marketing ? "Possible" : "Not applicable"}}` | Minimal | Low |
| R... | *Tenant adds local risks* | | | |

## 7. Measures to reduce risk

| Risk | Measures (Harbour) | Measures (tenant) | Effect | Residual risk | Approved |
| --- | --- | --- | --- | --- | --- |
| R1 | Role-based access with location, team, assignment and time scoping; Postgres row-level security; break-glass with justification and alert; audit of every view | Role design, joiners and leavers process, periodic access review | Reduced | | |
| R2 | SQLCipher encryption; auto-lock; remote wipe; device revocation ([kiosk.md](kiosk.md)) | MDM enrolment, lost-device reporting | Reduced | | |
| R3 | `tenant_id` on every row, `FORCE ROW LEVEL SECURITY`, isolation tests through the API and sync ([ADR-0002](../decisions/0002-tenancy-and-row-level-security.md)) | None | Reduced | | |
| R4 | Sync status banner, stale-data warning, conflict review, hazard log controls | Handover practice, device charging | Reduced | | |
| R5 | Retention engine, legal holds, destruction certificates | Set retention overrides deliberately | Reduced | | |
| R6 | Recorded sharing decisions; consent records; scoped portal access | Sharing policy | Reduced | | |
| R7 | UK hosting by default; AI off by default; register with geography | Choose providers knowingly | Reduced | | |
| R8 | 30-second lock, PIN plus enrolled device, photo picker, shift-end sign-out | Device policy, PIN-sharing policy | Reduced | | |
| R9 | Location used only to verify visits, scoped like the visit record (designed with the Phase 4 home care module) | Explain monitoring to people and staff | Reduced | | |
| R10 | AI off by default; pseudonymisation; drafts labelled and never acted on alone; scope lock; 12-month audit (section 9) | AI policy, training, accountable owner | Reduced | | |
| R11 | Per-person and per-family-member consent records; sections shared only under a sharing decision in force | Consent process; review of what is posted | Reduced | | |
| R12 | Consent recorded before any marketing message; withdrawal stops it | Consent wording; PECR check of channels | Reduced | | |

## 8. Sign-off

| Item | Name and date | Notes |
| --- | --- | --- |
| Measures approved by | | Integrate actions into the project plan |
| Residual risks approved by | | If any high residual risk remains, consult the ICO before going ahead (Art 36) |
| DPO advice provided | | DPO advises on compliance, section 7 measures and whether processing can proceed |
| DPO advice accepted or overruled (with reasons) | | |
| Consultation responses reviewed | | |
| This DPIA will be kept under review by | | Review on any configuration change Harbour flags, and at least annually |

---

## 9. AI addendum (required before the AI module is enabled)

The AI module is off by default. It is enabled per tenant only after this addendum is signed, a model provider is chosen and an accountable owner is named (master prompt 16). Guidance: [DHSC: using AI in adult social care](https://www.gov.uk/guidance/using-ai-in-adult-social-care).

| Item | Value |
| --- | --- |
| Accountable owner | *Tenant names* |
| Capabilities enabled | `{{ai.capabilities[]}}` (Ask Harbour, summaries, drafting, compliance monitor explanations, inspection preparation, rota assistant, finance commentary, voice to text) |
| Locations where enabled | `{{ai.locations[]}}` |
| Model provider and geography | `{{ai.provider}}`, `{{ai.geography}}` (default: Amazon Bedrock with in-Region models in London; Claude via Bedrock EU geography or the Anthropic API with zero data retention are optional and process data outside the UK; see [sub-processors.md](sub-processors.md)) |
| Tenant's own key (BYO) | `{{ai.byoKey ? "Yes: tenant's own contract with the provider applies" : "No"}}` |
| Training on tenant data | Not permitted by any provider contract |
| Data sent | Pseudonymised: names, NHS numbers, dates of birth and addresses replaced before sending and re-identified locally. Free-text notes only if enabled: `{{ai.freeTextEnabled}}`, and only for people with a consent record (records of processing B10). Attachments and photos never sent |
| Human control | Outputs are drafts or suggestions, labelled "AI draft"; no workflow changes state on model output alone (UK GDPR Arts 22A to 22D) |
| Scope lock | No diagnosis, prognosis, risk scoring, treatment or medication recommendations; clinical questions blocked and routed ([medical-device-boundary.md](medical-device-boundary.md)) |
| Audit | Every prompt, context set, model, version, output and user action logged (pseudonymised) for 12 months |
| Evaluation | Release evaluation results (golden questions, red-team, hallucination checks, bias checks for staff-related outputs) attached: `{{ai.evaluationReportUrl}}` |
| Controls | Per-tenant token budget, rate limits, operator kill switch; can be disabled per location |
| Communication | AI policy, staff training module, notice to people receiving care and families: published on `{{ai.noticeUrl}}` |
| Additional risks | Inaccurate drafts relied on without review; prompt injection through care notes; disclosure to the provider; bias in staff-related suggestions. *Tenant rates each and records measures* |

| Sign-off | Name and date |
| --- | --- |
| Accountable owner | |
| DPO | |
| Clinical lead or CSO (for summaries that include care records) | |

## 10. Family portal photos and updates (when the family portal is enabled)

| Item | Value |
| --- | --- |
| Purpose | Records of processing B8: photos and updates shared with named family members |
| Basis | Consent (Art 6(1)(a); Art 9(2)(a) explicit consent where a photo or update reveals health), recorded per person and per family member |
| Consent process | *Tenant describes how consent is asked for, recorded, reviewed and withdrawn, including for people who lack capacity* |
| What families see | *Tenant lists the sections shared and who decides (sharing decisions, people.md rule 13)* |

## 11. Marketing (when marketing is switched on)

| Item | Value |
| --- | --- |
| Purpose | Records of processing B9: marketing to families and enquirers |
| Basis | Consent (Art 6(1)(a)), and PECR for electronic messages |
| Consent wording | *Tenant records the wording used* |
| Channels | *Tenant lists the channels and checks each against PECR* |
