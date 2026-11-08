# Data protection impact assessment: Thapsus Care deployment template

**For**: each tenant (care provider), as controller. **Required because** the processing involves special category data about people who may be vulnerable, on a large scale, using new technology including offline mobile devices; these match the ICO's criteria for when a DPIA is needed ([ICO: when do we need to do a DPIA?](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/); UK GDPR Art 35).

**How it works**: Thapsus Care pre-fills this template from the tenant's configuration. Merge fields are shown as `{{field}}` and are filled from the tenant record; Thapsus Care re-generates the pre-filled sections when configuration changes and flags the DPIA for review. The tenant's DPO or named lead completes the remaining sections and **signs it in-app before go-live** (master prompt 5.1); the signer cannot be one of the people who prepared that version, and a risk still high after its measures needs the ICO's prior consultation reference first. A signed DPIA falls due for review when a purpose, sub-processor, data category or module appears that it did not cover, and yearly. Enabling the AI module requires the AI addendum (section 9) to be signed first (master prompt 16); the family portal and marketing add sections 10 and 11. Rules: [platform-completions.md](../specs/platform-completions.md) rules 17 to 22, `packages/domain/src/platform/dpia.ts`. Section 7A covers the Phase 1 residential care processing (risks R13 to R19), added 31 October 2026 for the Phase 1 gate. Section 7B is a first draft of the Phase 2 processing built so far (risks R20 to R29), not yet signed or in the in-app prefill.

---

## 1. Identification

| Field | Value |
| --- | --- |
| Controller | `{{tenant.legalName}}` |
| CQC provider ID | `{{tenant.cqcProviderId}}` |
| DPO or named lead | `{{tenant.dpo.name}}`, `{{tenant.dpo.email}}` |
| Caldicott Guardian | `{{tenant.caldicottGuardian.name}}` |
| SIRO | `{{tenant.siro.name}}` |
| Processor | Thapsus Cargo Ltd (Thapsus Care), under the data processing agreement signed `{{tenant.dpa.signedOn}}` |
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

How data is collected, stored, used, shared and deleted: staff record care at the point of care (often offline); records sync to Thapsus Care's UK-hosted database; access is limited by role, location, team, assignment and time; external professionals and families get scoped access where the tenant allows; records are kept under the retention schedule and then cryptographically shredded ([retention-and-deletion.md](retention-and-deletion.md)).

### 3.2 Scope

| Item | Value |
| --- | --- |
| Approximate number of people receiving care | `{{stats.activePeople}}` |
| Approximate number of staff users | `{{stats.activeStaff}}` |
| Data categories | From the tenant's records of processing ([records-of-processing.md](records-of-processing.md), Part B) |
| Geography | UK hosting (Google Cloud London, europe-west2; [ADR-0098](../decisions/0098-production-on-google-cloud.md)). Exceptions: `{{subProcessors.outsideUk[]}}` |

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

R1 to R8 apply to every tenant; R9 to R12 only with the processing named in the row; R13 to R19 are the Phase 1 residential processing every tenant has (section 7A lists which risks apply to each kind of processing); R20 to R29 are the Phase 2 processing (section 7B, a draft for the DPO; the processing under R22 and R25 is built but off or mock-only until the DPO's decisions, and a tenant records in section 7B.6 what it does not use). A DPIA signed before a standard risk was added is flagged for review. Thapsus Care fills this table from `packages/domain/src/platform/dpia.ts`, and a test (`dpia.test.ts`) fails if an id or its wording differs from this table.

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
| R13 | Disclosure to an inspector or commissioner beyond what the request needs, or after the link should have ended | Possible | Significant | Medium |
| R14 | A bulk copy of many people's records (full export, downtime pack, printed transfer pack) lost, kept too long or reaching the wrong person | Possible | Severe | High |
| R15 | Search or break-glass showing a person outside the searcher's scope, or break-glass used without a real need | Possible | Significant | Medium |
| R16 | A letter or email sent to the wrong recipient, or special category data sent by email | Possible | Significant | Medium |
| R17 | A statutory notification to a regulator that is wrong, late or holds more personal data than the form needs | Possible | Significant | Medium |
| R18 | Consent, capacity or DoLS records wrong or out of date, so a person is restricted or decided for without valid authority | Possible | Severe | High |
| R19 | Sample data mixed with real records, or a real person's data entered as sample data | Remote | Significant | Low |
| R20 | Staff vetting and employment records (DBS and criminal offence data, right to work and immigration, health declarations, fit notes) seen beyond HR or kept too long | Possible | Severe | High |
| R21 | The identity of a whistleblower or the subject of a case disclosed, or a silo reached by a wider role | Possible | Severe | High |
| R22 | Clock-in location, NFC and lone-worker check-ins used to monitor staff beyond their purpose | Possible | Significant | Medium |
| R23 | A subject access bundle or disclosure that reveals third parties, misses records or goes beyond its legal basis | Possible | Significant | Medium |
| R24 | A breach not assessed or reported within 72 hours, or a tenant not told by Thapsus as processor | Possible | Severe | High |
| R25 | Payroll, vetting, learning and e-signature providers receiving staff or care data, possibly outside the UK | Possible | Significant | Medium |
| R26 | Imported data inaccurate, excessive, or about people outside the service | Possible | Significant | Medium |
| R27 | An identity provider account linked to the wrong member, or sign-in without Thapsus Care's second factor | Possible | Severe | High |
| R28 | A respondent identified from small-group staff survey results | Possible | Significant | Medium |
| R29 | Applicants' data kept after an unsuccessful application or used beyond recruitment | Possible | Significant | Medium |
| R... | *Tenant adds local risks* | | | |

## 7. Measures to reduce risk

| Risk | Measures (Thapsus Care) | Measures (tenant) | Effect | Residual risk | Approved |
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
| R13 | People in the request's scope only; third parties and staff by role; identifiers and unreviewed free text withheld; a recipient-bound link with a one-time code sent to the recipient's work email, an expiry and revocation; the bundle deleted when the link ends; every open audited (section 7A) | Check the recipient and their work email; release only what the request needs; revoke when the inspection ends | Reduced | | |
| R14 | Full export: owner only, fresh sign-in with MFA, one download then deleted. Downtime pack: fresh sign-in, hourly limit, PDF never stored, no photos printed, kiosk copy encrypted. Transfer pack: printed from a stored snapshot, each print audited with the hospital named (section 7A) | Where a downloaded export is kept and who holds it; secure storage and shredding of printed packs; transfer packs handed over in person | Reduced | | |
| R15 | Search only where the searcher's permissions and scope reach, MFA for care records, audit without the words typed; break-glass with a typed reason, alerts to the Registered Manager and the data protection lead, a daily search limit and the weekly report (section 7A) | Review the weekly break-glass report; act on misuse | Reduced | | |
| R16 | Approved templates never approved by their author; recipient limited to the person or their own contacts; NHS number, date of birth and special category fields never in an email; incident and candour letters by letter only (section 7A) | Approve template wording; keep contacts' addresses current | Reduced | | |
| R17 | Notifications and deadlines worked out from the incident's answers, overdue escalation, submission only by holders of `safety.notification.submit` after a fresh sign-in, raiser cannot close (section 7A) | Name who submits; check each form before it is sent | Reduced | | |
| R18 | Capacity test in the Act's words, authority checked against the contact's legal authority, best-interests checklist, DoLS expiry reminders, every version kept (section 7A) | Mental Capacity Act policy and training; DoLS applications and reviews on time | Reduced | | |
| R19 | Invented sample people only, flagged, badged, watermarked, left out of the full export (not yet of statutory notifications: a draft about a sample person is decided not required, H-452), removed as a batch (section 7A) | Remove sample data before go-live | Reduced | | |
| R20 | Staff file permissions of their own (owner and HR by default), MFA, row-level security; HR-only documents (fit notes included) hidden from everyone without `workforce.hr_document.read` and every open audited; sponsor records HR only; no DBS certificate copy kept; vetting ports send only their declared fields; the rota and absence screens learn only yes or no; leavers' access ended on time (section 7B) | Who holds HR and pay access; the appropriate policy document; retention of staff files | Reduced | | |
| R21 | Speaking up and casework in silos no wider role, grant or break-glass reaches (ADR-0089); anonymous concerns with no identity stored, audit without the reporter, the lead's export with step-up; the safeguarding log for its managers only, carers see protective measures only (section 7B) | Name the Freedom to Speak Up lead and the caseworkers; guidance to reporters | Reduced | | |
| R22 | Location and NFC evidence off: the phone sends none, the API keeps a word only where a location's setting asks for it, never a position; lone-worker location off by default, one point per event the worker sends, never a track, erased after `lone_worker.location_days`; check-ins made by the worker, never used to judge performance (section 7B) | Explain monitoring to staff; switch nothing on before the employee-monitoring DPIA (H-527) | Reduced | | |
| R23 | Subject map over every table, third-party names highlighted but decided by a person with a reason, bundle built when issued and never stored, its SHA-256 recorded; disclosure requests carry their legal basis, are approved by someone other than the requester with step-up and leave only by the recipient's secure route (section 7B) | Review each record before a bundle or pack is issued | Reduced | | |
| R24 | ICO clock worked out on every read, decision with reasoning, late reports need reasons, Thapsus notices open the register entry and tell the data protection lead (section 7B) | Name who decides on reporting and who deputises | Reduced | | |
| R25 | No adapter on by default and only mocks, refused in production: payroll exports only of a locked run, on request with step-up, minimum fields (no name, date of birth, NI number or bank detail), the provider the organisation's own processor (ADR-0097); vetting and learning platform ports send only declared fields; signing stays in Thapsus Care unless DocuSign is assessed (H-540); OCR unavailable until Document AI in europe-west2 (H-1262); the Thapsus-HR link UK only; each provider assessed before it is switched on (section 7B, H-793) | Choose providers knowingly | Reduced | | |
| R26 | Only mapped columns kept, staged rows in quarantine and deleted at commit, discard or expiry, matching never merges, imported medicines "not yet checked" and care plans as drafts, undo of a whole commit, organisation-wide importers only; doubtful Thapsus-HR matches to a person (section 7B) | Check the source export; sign off a sample after committing | Reduced | | |
| R27 | Links only invited members, DNS-proved domains, Thapsus Care's own second factor still asked for care records and step-up, keys in the managed store only (section 7B) | The identity provider and its contract | Reduced | | |
| R28 | Results only once a survey has closed and at least `wellbeing.survey_min_group_size` answered (an organisation can raise it, never lower it), each question likewise, no count below the size, no breakdown or export of responses; responses hold no member and no time but the week, are closed to the application role and audited with an anonymous actor; check-ins seen by a manager only while the member shares them (section 7B; scheduling.md section 20) | Set the smallest group shown (it can only be raised); warn staff that free text can identify them | Reduced | | |
| R29 | Unsuccessful applicants kept 6 months (talent pool by consent), interview notes never passed to the staff file, equality monitoring kept apart and counted with small counts suppressed (section 7B) | Applicant privacy notice; the equality questions | Reduced | | |

## 7A. Phase 1 processing: residential care records

What Thapsus Care's Phase 1 (residential care records) does with personal data, the risks in section 6 that apply to each kind of processing, the measures built, the residual risk Thapsus Care expects once both Thapsus Care's and the tenant's measures are in place, and what the tenant, as controller, must decide or sign off. The tenant rates the residual risk for each risk id in section 7; the expected level here is guidance, not the rating. Fields marked *Tenant completes* are the provider's own.

### 7A.1 Lawful bases

Taken from the records of processing ([records-of-processing.md](records-of-processing.md), Part B). Consent is **never** the lawful basis for care records; it covers only optional processing (B8 to B10). A consent record in the care record is the person's decision about their care, not a lawful basis.

| Processing | Article 6 basis | Article 9 condition |
| --- | --- | --- |
| Care records (B1): people lifecycle, care plans, assessments, notes, charts, body map and photos for care, capacity and DoLS records, downtime and transfer packs, break-glass and search | Keeping the care record: Art 6(1)(c) legal obligation (Regulation 17(2)(c) of the 2014 Regulations) for every person, a self-funder included, so portability does not apply (H-612). Delivering the care: independent provider Art 6(1)(b), or 6(1)(f) where the contract is with a funder; public body Art 6(1)(c) or 6(1)(e) | Art 9(2)(h) with DPA 2018 s.10(2) and Schedule 1 paragraph 2 (health or social care purposes), by or under the responsibility of staff under a duty of confidentiality (Art 9(3), DPA 2018 s.11) |
| Family members and representatives (B2), and sharing with them under a sharing decision other than consent | Art 6(1)(f), or 6(1)(e) for a public body | Art 9(2)(h) with DPA 2018 Schedule 1 paragraph 2 where health information is shared, including under a legal authority or a best-interests decision (Art 6(1)(f), or 6(1)(e) for a public body); every sharing decision lasts at most `sharing.decision_max_months` (12 months) or to the authority's end date if sooner (H-38; DPO verifies against ICO guidance) |
| Safeguarding (B4) | Art 6(1)(ea) recognised legitimate interest, or 6(1)(c) or (e) for a public body | Art 9(2)(g) with DPA 2018 Schedule 1 paragraph 18, with an appropriate policy document |
| Audit, break-glass and search records (B5) | Art 6(1)(c) or 6(1)(f); 6(1)(c) or (e) for a public body | As B1 where a typed reason mentions health |
| Incidents, statutory notifications, candour and inspector evidence packs (B7) | Art 6(1)(c) legal obligation (for evidence packs, Health and Social Care Act 2008 s.64 where CQC requires the information) | Art 9(2)(h) with Schedule 1 paragraph 2 (for evidence packs paragraph 2(2)(f)), or Art 9(2)(i) with Schedule 1 paragraph 3 for public health |
| Family feed photos and update notifications (B8, optional) | Art 6(1)(a) consent | Art 9(2)(a) explicit consent where a photo or update reveals health |
| Full export | The controller's own copy of its data, not a disclosure; each category keeps its own basis | As the category |
| Sample data | Not personal data: invented people only | None |

### 7A.2 Risks, measures and decisions

| Processing | Risks | Measures built (evidence) | Expected residual | Tenant decides or signs off |
| --- | --- | --- | --- | --- |
| People lifecycle: enquiries, pre-admission, decisions to admit and their conditions, admission, welcome checklist, rooms and beds, property and keys, reviews, hospital transfer packs, discharge, transfer and death | R1, R4, R5, R6, R14 | Workflows with checklists and a second person to confirm residents' money at exit (`packages/domain/src/people/pre-admission.ts`, `admission.ts`, `property.ts`, `reviews.ts`, `transfer-pack.ts`, `exit.ts`; `apps/api/src/routes/people-lifecycle.ts`, `people-exit.ts`, `people-transfers.ts`); the transfer pack is a stored snapshot printed on request, each print audited with the hospital named ([ADR-0040](../decisions/0040-transfer-pack-pdf-writer.md), HZ-023); pre-admission records and the property inventory are not sent to devices (records of processing A2); retention `care_record` ([retention.md](../specs/retention.md)) | Low: enquiries closed without an assessment are kept 12 months, and assessments of people never admitted 3 years from the decision (H-39, verify) | Who may print transfer packs and how they travel with the person. *Tenant completes* |
| Care plans and risk assessments | R1, R4 | Drafts, published and superseded versions with every earlier version kept, review dates and change triggers (`packages/domain/src/care/care-plan.ts`, `risk-assessment.ts`, HZ-024); access per permission and scope in the API and in row-level security ([ADR-0071](../decisions/0071-data-scope-is-per-permission.md), `apps/api/test/route-gates.test.ts`, `apps/api/test/scope-per-permission.test.ts`) | Low | Who may publish a plan; how the person and their representatives take part. *Tenant completes* |
| Assessments and validated tools (MUST, Waterlow, Braden, NEWS2, NG249 falls) | R4 | Each tool calculated exactly as published, with its workings shown and table-driven tests (`packages/domain/src/care/must.ts`, `waterlow.ts`, `braden.ts`, `news2.ts`, `falls.ts`, HZ-012); the result links the tenant's own escalation policy (`packages/domain/src/care/escalation-policy.ts`); no other score, diagnosis or recommendation ([medical-device-boundary.md](medical-device-boundary.md)); no decision is taken on a result alone (UK GDPR Art 22) | Low | The escalation policy for each tool and band; the tool licences (H-25). *Tenant completes* |
| Daily notes and charts | R1, R2, R4 | Append-only entries with client ids, so a retry never duplicates; corrections are new entries with a reason; late-entry and clock-drift flags (`packages/domain/src/care/entries.ts`, HZ-017, HZ-029, HZ-010); note text copied into a search column in the same row ([ADR-0070](../decisions/0070-search-on-postgres-full-text.md), H-380) | Low | Recording standards for staff. *Tenant completes* |
| Body map and photos | R1, R6 | The side of a mark worked out by the server from the drawing (`packages/domain/src/care/body-map.ts`, HZ-019); photos stored as documents, checked by content, scanned for malware and stored encrypted (`apps/api/src/routes/documents.ts`, `packages/domain/src/platform/documents.ts`, [ADR-0031](../decisions/0031-document-storage-scanning-and-destruction.md)); care and identification photos never reach the family feed, which takes only `feed_photo` documents (records of processing, family feed row) | Medium: photos of the body are intimate | When staff photograph a wound or skin, on which devices, and how the person is told (the basis is B1, not consent). *Tenant completes* |
| Consent, capacity, best interests and DoLS | R1, R18 | The two-stage capacity test in the Act's words; consent and authority checked against the contact's recorded legal authority; the best-interests checklist; the DoLS register with expiry reminders and the legal-change review; every earlier version kept (`packages/domain/src/care/mca/capacity.ts`, `consent.ts`, `best-interests.ts`, `dols.ts`, `apps/api/src/routes/mca.ts`, HZ-020, HZ-026) | Medium | The Mental Capacity Act policy; who may assess capacity; the DoLS reminder days (H-64). *Tenant completes* |
| Incidents, investigations, statutory notifications and duty of candour | R1, R17 | The classifier's questions decide which notifications apply and their deadlines, with overdue escalation (`packages/domain/src/safety/classifier.ts`, `notifications.ts`, HZ-013, HZ-090, HZ-091); only holders of `safety.notification.submit` submit, after a fresh sign-in (`apps/api/src/routes/statutory-notifications.ts`); the person who raised an incident cannot close it (`packages/domain/src/platform/separation-of-duties.ts`); readers who see only some of the people on an incident see only their own ([ADR-0033](../decisions/0033-incident-scope.md)); candour letters go to the relevant person only (H-103); retention `serious_incident` once a notification applies | Medium: incidents hold third parties' data | Who holds `safety.notification.submit`; the check of each form before it is sent; the candour process. *Tenant completes* |
| Family feed and portal | R6, R11, R16 | Only sections a sharing decision covers, checked on every read (`packages/domain/src/people/sharing.ts`, `packages/domain/src/comms/feed-visibility.ts`, HZ-022); composing refuses other residents' and staff names and holds publishing while an incident about the person is open (`packages/domain/src/comms/feed-compose.ts`, `feed-text.ts`, HZ-061); notifications carry a generic line and a link only ([ADR-0060](../decisions/0060-family-notification-channels.md), HZ-060); the portal reaches only the family member's own rows ([ADR-0061](../decisions/0061-family-portal-scope-and-row-level-security.md)); photos only under consent or a best-interests decision, taken down when it ends (`photoItemsToWithdraw`); family email through the organisation's email provider (H-08), carrying no update content; notification delivery logs kept 12 months (H-106) | Medium | The sharing policy; the feed defaults (H-107); section 10. *Tenant completes* |
| Break-glass (opening a record and searching) | R1, R15 | A typed reason and a reason code; an alert to the Registered Manager and the data protection lead, and an audited record when no one could be told; a daily limit on break-glass searches, which show identity only and exact matches; the weekly report (`apps/api/src/routes/break-glass-search.ts`, `apps/api/src/routes/break-glass-report.ts`, `packages/domain/src/people/break-glass-report.ts`, `apps/api/test/break-glass-search.test.ts`) | Medium: depends on the weekly review | Who reviews the weekly report, and what happens on misuse. *Tenant completes* |
| Search | R15 | `platform.search.use`; each kind of record searched only where the searcher's permissions and scope reach, with MFA for care records; the audit keeps what was shown, never the words typed (`packages/domain/src/platform/search.ts`, `apps/api/src/routes/search.ts`, `apps/api/test/search.test.ts`, HZ-011) | Low | The search copies in backups (H-380). Search audit events that showed no person are kept 6 months as `security_log` (H-121) |
| Full export | R14 | The owner only, after a fresh sign-in with MFA; one download, then the archive is deleted; an expiry; secret and internal columns never leave; sample people left out (`packages/domain/src/platform/export.ts`, `export-catalogue.ts`, `apps/api/src/routes/exports.ts`, [platform-completions.md](../specs/platform-completions.md) rules 10 to 16, HZ-070, HZ-071) | Medium: once downloaded, the copy is the tenant's to protect | Who may ask for an export; where a downloaded export is kept and when it is destroyed; the expiry (H-118). *Tenant completes* |
| Inspector evidence packs and their links | R13 | Minimised by rule: people in scope only, third parties and staff by role, identifiers withheld, free text withheld until redacted by hand; a recipient-bound link with a one-time code sent to the recipient's work email, an expiry and revocation; the bundle deleted when the link ends; watermarked; every open audited (`packages/domain/src/quality/evidence-pack.ts`, `apps/api/src/routes/evidence-packs.ts`, `apps/api/src/routes/evidence-link.ts`, [ADR-0050](../decisions/0050-evidence-pack-links.md), HZ-050); retention `evidence_pack` | Low | The basis, redaction rules and defaults (H-96, H-217, H-218); who may release a pack. *Tenant completes* |
| Downtime packs and outages | R2, R14 | A fresh sign-in and an hourly limit to build or print; the PDF drawn on request and never stored; no photos printed; the kiosk copy encrypted and opened only in a PIN session of a holder of `operations.downtime.read` (`packages/domain/src/operations/downtime-pack.ts`, `kiosk-cache.ts`, `apps/api/src/routes/operations.ts`, [kiosk.md](kiosk.md), HZ-021); retention `downtime_pack` (one month) | Medium: printed copies are outside Thapsus Care | Secure storage and shredding of printed packs in the business continuity plan; the downtime defaults (H-98). *Tenant completes* |
| Sample data | R19 | Invented people only (999-range NHS numbers, `example.invalid` emails), flagged and badged, watermarked or marked "Sample" on print, left out of the full export (not yet of statutory notifications, H-452), removed as a batch (`packages/domain/src/platform/sample-data.ts`, `apps/api/src/routes/sample-data.ts`, HZ-072) | Low | Remove sample data before go-live; the sample telephone numbers (H-123) |
| Offline devices and held entries | R2, R8 | Device copies encrypted with SQLCipher and wiped at sign-out, remote sign-out or revocation; the offline window set in the signed sync token; entries unsent at sign-out held for their owner only, and deleted only with a coded reason that is audited (`packages/sync/src`, `apps/api/src/routes/sync.ts`, `devices.ts`, `refused-entries.ts`, `packages/domain/src/care/discard-reasons.ts`, [ADR-0011](../decisions/0011-offline-window-and-kiosk-lock.md), [ADR-0029](../decisions/0029-mobile-offline-stack.md), HZ-040, HZ-110, [care.md](../specs/care.md) section 6) | Medium | MDM enrolment and lost-device reporting; the interim device positions (H-68). *Tenant completes* |
| Letters and emails from templates | R16 | Approved templates only, never approved by their author; the recipient is the person or one of their own contacts; NHS number, date of birth and special category fields never in an email; incident and candour letters by letter only (`packages/domain/src/comms/templates.ts`, `apps/api/src/routes/letters.ts`, `letter-templates.ts`, [ADR-0051](../decisions/0051-personal-data-in-template-emails.md), HZ-051) | Low | Approving the templates; keeping contacts' addresses current; the email connection (H-356). *Tenant completes* |

### 7A.3 Tenant's local notes

| Item | Value |
| --- | --- |
| Phase 1 processing the tenant does not use (and why) | *Tenant completes* |
| Local risks added in section 6 | *Tenant completes* |
| Who reviewed section 7A, and when | *Tenant completes* |

## 7B. Phase 2 processing: workforce, rights and safety (draft)

**Status: draft for the DPO, not signed and not approved.** First written 31 October 2026 and
brought up to date on 7 November 2026 for plan slice 84 ([phase-2.md](../plans/phase-2.md)), from
`main` at that date. It covers the Phase 2 slices on `main`:

- workforce: 11 staff file, 17 training and competence, 23 applicants, 29 induction and leavers,
  35 sponsor licence and the staff privacy notice, 39 employee relations casework, 43 e-learning,
  77 vetting adapters, 78 learning platform imports;
- rota, time and pay: 12 dependency tool, 21 rota, 27 bank and agency workers, 30 time and
  attendance, 36 pay runs, 40 absence and leave, 44 wellbeing, 46 lone working, 76 payroll
  exports, and 71 shifts, the clock and lone working on the phone;
- safety: 13 safeguarding log, 18 complaints, 24 speaking up, 31 outbreaks, 37 deaths and missing
  persons, 41 disclosure requests;
- quality: 14 framework and evidence, 19 audits, 25 policy library, 32 data security evidence, 47
  quality dashboard;
- platform: 15 DSAR workbench, 20 breach register, 26 and 51 imports, 33 single sign-on;
- integrations: 79 e-signature and OCR, 86 to 90 the Thapsus-HR link;
- medicines (lane A) and the phone (68, 72), which add no new risk id (section 7B.4);
- the web screens built for these slices.

Evidence paths are files on `main`. Slices not on `main` on that date (among them the phone's
medicines round, 69 and 70) are added when they merge (section 7B.6).

R20 to R29 are in sections 6 and 7 and in the in-app prefill (`packages/domain/src/platform/dpia.ts`
and its test), as Phase 1 did for R13 to R19. A DPIA signed before they were added is flagged for
review (`dpiaReviewTriggers`, `new_standard_risk`); a basis saved before standard risks were
recorded counts as covering R1 to R8 only, so it is flagged for R13 to R29. The expected
residual levels below are Thapsus Care's guidance, not the tenant's rating; fields marked *Tenant
completes* are the provider's own.

### 7B.1 Lawful bases

Taken from the records of processing ([records-of-processing.md](records-of-processing.md): Part B
and the data categories table). Every basis here is a proposal until the DPO confirms it (H-526,
H-790). Where the records of processing name no basis, this table says so and section 7B.6 lists
the gap; this section does not supply one.

| Processing | Article 6 basis | Article 9 or Article 10 condition |
| --- | --- | --- |
| Staff file, pre-employment checks and vetting checks (B3; slices 11 and 77) | Art 6(1)(b) contract of employment; 6(1)(c) where a law requires the record (regulation 19 and Schedule 3 of the 2014 Regulations; Immigration, Asylum and Nationality Act 2006 for right to work). The worker's consent to a DBS check is recorded because the DBS requires it, and is not the lawful basis (H-1124) | Health: Art 9(2)(b) with DPA 2018 Sch 1 para 1. Criminal offence data (a DBS check or Update Service status check and its result, never the certificate's contents): Art 10 with DPA 2018 s.10(5), Sch 1 para 1 and para 18. Both need the provider's appropriate policy document (H-576) |
| Induction, the Care Certificate and leavers; training, competence and supervision; e-learning; learning platform imports (B3; slices 17, 29, 43, 78) | As B3: Art 6(1)(b), and 6(1)(c) (Regulations 18 and 19 of the 2014 Regulations, named for training records and imports) | None asked for. Probation notes, an exit interview summary or a withdrawal reason may reveal health in free text; no condition is named for that (section 7B.6) |
| Sponsor licence duties, the staff privacy notice and LDSS claims (B3; slice 35) | Art 6(1)(c) (the sponsor duties a sponsor licence carries) and 6(1)(b) | None (nationality is implied by sponsorship; no special category field) |
| Staff photo or image in the organisation's publications (B3a; slice 35) | Art 6(1)(a) consent, per purpose, withdrawable | None |
| Employee relations casework (B3; slice 39) | Art 6(1)(b) and (c); a DBS referral Art 6(1)(c) (Safeguarding Vulnerable Groups Act 2006 s.35) | Health: Art 9(2)(b) with Sch 1 para 1. Allegations of criminal conduct and referral decisions: Art 10 with s.10(5), Sch 1 para 1 and para 18 (H-800, H-802) |
| Rota, bank and agency workers (B3; slices 21 and 27) | As B3 for staff. For agency workers, whom the organisation does not employ, the records of processing name no Article 6 basis of their own (section 7B.6; H-547) | Coded reasons on an agency worker's AWR record (sickness, pregnancy or maternity): Art 9(2)(b) with Sch 1 para 1 |
| Time and attendance and working-time records, on the web and the phone (B3; slices 30 and 71) | As B3: Art 6(1)(b), and 6(1)(c) where a law requires the record. The records of processing call location and NFC evidence employee monitoring but name no basis for it (section 7B.6; H-527) | None asked for |
| Absence and leave, fit notes and return to work (B3; slice 40) | As B3 | Art 9(2)(b) with Sch 1 para 1 and the appropriate policy document; Art 9(2)(h) where occupational health advice is given (H-974) |
| Pay calculation runs (B3; slice 36) | Art 6(1)(b) and 6(1)(c) (minimum wage, SSP, holiday and auto-enrolment records) | Sickness dates in a period of incapacity: Art 9(2)(b) with Sch 1 para 1, under the appropriate policy document |
| Payroll and pension exports (B3; slice 76) | Art 6(1)(c) (paying wages, tax, National Insurance and auto-enrolment, Pensions Act 2008) and 6(1)(b) | None: SSP leaves only as an amount, never a reason |
| Thapsus-HR link (B3; slices 86 to 90) | The contract with the employee and legal obligations (minimum wage, working time, SSP). Not yet a purpose row of its own (H-1341; section 7B.6) | Sickness dates: Art 9(2)(b) |
| Lone-worker safety (B3; slices 46 and 71) | Art 6(1)(c) (Health and Safety at Work etc. Act 1974 s.2; Management of Health and Safety at Work Regulations 1999 reg 3), with 6(1)(f) for what goes beyond it (H-1033) | Art 9(2)(b) with Sch 1 para 1 where an alarm note reveals an injury |
| Staff wellbeing and voice (B3; slice 44) | Art 6(1)(f) (hearing staff and supporting their wellbeing); 6(1)(e) for a public body. Voluntary, never a condition of work (H-1080) | Art 9(2)(b) with Sch 1 para 1 for a check-in the member shares with their manager. None is named for a check-in the member keeps to themselves (section 7B.6) |
| Safeguarding log (B4; slice 13) | Art 6(1)(ea) recognised legitimate interest, or 6(1)(c) or (e) for a public body | Art 9(2)(g) with Sch 1 para 18, with an appropriate policy document; Art 10 where a concern alleges a crime |
| Data subject requests (B5 and B13; slice 15) | Art 6(1)(c): the controller's duties under UK GDPR Articles 12 to 22 | Indirect: a bundle carries the subject's own special category data to them |
| Complaints and compliments (B14; slice 18) | Complaints: Art 6(1)(c), Regulation 16. Compliments: Art 6(1)(f) | Art 9(2)(h) with Sch 1 para 2 where a complaint or compliment reveals health (B14, a purpose of its own, H-700) |
| Breach register and data protection complaints (B13; slice 20) | Art 6(1)(c) (UK GDPR Arts 33 and 34; the duty to handle data protection complaints) | Art 9(2)(g) with Sch 1 para 6 where a description reveals health (DPO to confirm, H-671) |
| Applicants and recruitment (B15; slice 23) | Art 6(1)(b) steps before a contract and 6(1)(f); talent pool Art 6(1)(a) consent, withdrawable | Equality monitoring only: Art 9(2)(g) with Sch 1 para 8, voluntary, kept apart, reported as suppressed counts (H-576) |
| Whistleblowing and speaking up (B16; slice 24) | Art 6(1)(f) (protecting workers under the Public Interest Disclosure Act 1998, and safe care); 6(1)(e) for a public body | Art 9(2)(b) with Sch 1 para 1, or 9(2)(h) with Sch 1 para 2 where a concern reveals health; Art 10 with Sch 1 para 10 where it alleges a crime |
| Policy read-and-sign (B3 and B6; slice 25) | Art 6(1)(b) or (c) (staff compliance records) | None |
| Import of records from a previous system (slices 26 and 51) | The basis of the records imported (B1 for people, medicines and care plans; B3 for staff file checks; B2 as contacts land); no new purpose | As the records imported |
| Single sign-on links (B3 and B5; slice 33) | Art 6(1)(b) and (f) (authenticating staff for employment and security) | None |
| Outbreak line list (B7; slice 31) | Residents: as care records (B1). Staff cases: Art 6(1)(c), Regulation 12(2)(h) of the 2014 Regulations (infection control) | Art 9(2)(i) with Sch 1 para 3 (public health), and Art 9(2)(b) with Sch 1 para 1 for staff cases. Staff cases are kept 3 years from the outbreak's closure (`outbreak_staff_case`); agency workers not in Thapsus Care are counted unnamed (H-767, H-782, recommended answers applied 31/10/2026) |
| Deaths and missing persons (B1 and B7; slice 37) | The death record, mortality review and missing person timeline: as care records (B1); the notifications: B7. The Herbert Protocol profile given to the police: proposed Art 6(1)(d) vital interests, or 6(1)(e) for a public body (H-772) | Art 9(2)(h) for the care record; for the profile given to the police, proposed Art 9(2)(c) where the person cannot consent, or Sch 1 para 18 (H-772) |
| Disclosure requests (B4 and B7 conditions; slice 41) | Stored with each request for its type: Art 6(1)(c) for coroners (Coroners and Justice Act 2009 Sch 5), Safeguarding Adults Reviews (Care Act 2014 ss.44 and 45) and Domestic Homicide Reviews (Domestic Violence, Crime and Victims Act 2004 s.9); for the police and solicitors, the Article 6 basis beside the DPA 2018 Sch 2 para 2 or para 5 exemption, never the exemption alone; the Access to Health Records Act 1990 for people who have died (outside UK GDPR) (H-592, H-821) | The B4 or B7 condition, named beside the statute or exemption (H-821) |
| E-signature requests and OCR of scanned MAR charts (B1, B3 and B5; slice 79) | OCR: as the person's medicines record (B1). Signature requests: B3 and B5 | OCR: Art 9(2)(h) as B1. Signatures: none |
| Medicines record, administrations, controlled drugs, stock, PRN, covert administration and errors (B1, and B7 for errors; lane A) | As care records (B1), never consent | Art 9(2)(h) as B1 |
| Dependency categories (B1; slice 12) | As B1 (H-711) | As B1 |

### 7B.2 Which risks apply to which processing

| Slice and processing | Risks (section 6 and below) |
| --- | --- |
| 11 Staff file and pre-employment checks | R20, R1, R5 |
| 17, 43, 72, 78 Training, competence, supervision, e-learning (also offline on the phone) and learning platform imports | R1, R5; R25 and R26 for imports (78) |
| 23 Applicants and recruitment | R29, R20 (a hired applicant's checks) |
| 29 Induction, the Care Certificate and leavers | R20, R1, R5 |
| 35 Sponsor licence, staff privacy notice, image consent and LDSS claims | R20, R5 |
| 39 Employee relations casework | R21, R20, R5 |
| 77 Vetting adapters | R25, R20 |
| 21, 27 Rota, bank and agency workers | R1, R20 (the rota learns only whether a check blocks a shift) |
| 30, 71 Time and attendance, and the clock on the phone | R22, R1, R5 |
| 36, 40 Pay runs, absence, fit notes and return to work | R20, R1, R5 |
| 76 Payroll and pension exports | R25, R7 |
| 86 to 90 Thapsus-HR link | R25, R26 and R1; the plan assigns R30 to it (wrong matching, out-of-date data and over-sharing), not yet written (section 7B.6) |
| 46, 71 Lone working, on the web and the phone | R22, R2 |
| 44 Wellbeing surveys, recognition and check-ins | R28, R1 |
| 13 Safeguarding log | R21 (the person an allegation is about), R1, R5, R6 |
| 18 Complaints and compliments | R1, R5, R23 (complainants as third parties in a DSAR) |
| 24 Whistleblowing and speaking up | R21 |
| 31 Outbreaks | R1, R5, R17 |
| 37 Deaths and missing persons | R1, R6 (the Herbert Protocol profile given to the police), R17 |
| 41 Disclosure requests | R23 |
| 15 DSAR workbench | R23, R5 |
| 20 Breach register and data protection complaints | R24 |
| 26, 51 Import wizard: people, contacts, allergies, staff, medicines and care plans | R26, R4, R3 |
| 33 Single sign-on | R27, R1 |
| 79 E-signature and OCR | R25, R7, R4 (values read from a chart stay unconfirmed until a person decides each) |
| 25 Policy library and read-and-sign | No new risk: R1 and R5 (section 7B.4) |
| 14, 19, 32, 47 Quality framework, audits, data security evidence and dashboard | No new risk: R1 (section 7B.4) |
| 12 Dependency tool | No new risk: R1, R4 (section 7B.4) |
| Medicines (lane A) and their sync to the phone (68) | No new risk: R1, R2, R4, R8, R14 (section 7B.4) |

### 7B.3 Risks R20 to R29

Likelihood, severity and overall use the scale in section 6. "Initial" is before Thapsus Care's
measures; "expected residual" is with Thapsus Care's measures built and the tenant's in place.

#### R20 Staff vetting and employment records (DBS and criminal offence data, right to work and immigration, health declarations, fit notes) seen beyond HR or kept too long

| Field | Value |
| --- | --- |
| Slices | 11, 23 (a hired applicant's checks), 29, 35, 36, 39, 40 and 77 (all built); 21 and 27 read checks without seeing them |
| Initial | Possible, severe, **high** |
| Measures built (evidence) | Staff file permissions of their own (`workforce.staff_file.read`, `.manage`, `workforce.hr_document.read`, `workforce.dbs_risk_assessment.sign`), owner and HR by default, MFA ([workforce.md](../specs/workforce.md) section 3); forced row-level security on `staff_profile` and `compliance_item`, read by holders and by the worker for their own file, never written on one's own (`packages/db/drizzle/0073_staff_profile.sql`); HR-only documents hidden by the `document_hr_only` policy from everyone without `workforce.hr_document.read`, never served by the general document routes or found by search, every open audited as `workforce.hr_document.viewed` (`apps/api/src/routes/staff-files.ts`); no DBS certificate copy and no right to work share code kept (`packages/domain/src/workforce/staff-file.ts`); vetting ports send only each port's declared fields and refuse an answer carrying anything more, such as a certificate's contents (`apps/api/src/integrations/vetting.ts`). Sponsored-worker records HR only (`workforce.immigration.read`, `workforce.sponsor.manage`), never one's own (`apps/api/src/routes/sponsorship.ts`). Fit notes and return to work notes are HR-only documents, never the condition typed into Thapsus Care; rota managers learn only that someone is away and the kind; the Bradford factor and SSP working are never stored (`apps/api/src/routes/absences.ts`, `packages/db/drizzle/0107_absence_leave.sql`). Pay runs only for organisation-wide pay holders with MFA; a member reads their own (`apps/api/src/routes/pay.ts`). The rota asks the workforce port whether a member may work and learns only the answer (`packages/domain/src/workforce/roster-checks.ts`). Leavers' access ends at the end of the leaving day or their last shift that day, and a staff file with no keep-until date raises a review (`sweepLeaverAccess` in `apps/api/src/jobs/tasks.ts`, H-873, H-874). Expiry reminder tasks carry opaque ids and a generic title and reach HR's inbox through the task's required permission (`apps/api/src/routes/tasks.ts`) |
| Open measures | No scheduled job yet destroys staff files, HR-only documents, absences or pay runs when their class ends; destruction past retention is a person's action through the retention screens (section 7B.5) |
| Expected residual | Possible, significant, **medium** until destruction runs on time; then remote, significant, **low** |
| DPO decides | What of a DBS check is kept and for how long (H-575); the appropriate policy document for health and criminal offence data (H-576); the lawful basis for vetting results (H-1124); the fit note condition (H-974) and `sickness_absence` retention (H-973); the staff privacy notice (H-578); retention of the staff file as the tenant selects (H-525). *Tenant completes*: who holds HR and pay access at each home |

#### R21 The identity of a whistleblower or the subject of a case disclosed, or a silo reached by a wider role

| Field | Value |
| --- | --- |
| Slices | 24 speaking up, 39 casework, 13 (the person a safeguarding allegation is about); all built |
| Initial | Possible, severe, **high** |
| Measures built (evidence) | Two silo permissions, `safety.speak_up.manage` and `workforce.casework.manage` (`SILO_PERMISSIONS` in `packages/domain/src/platform/permissions.ts`; [ADR-0089](../decisions/0089-restricted-silos-whistleblowing.md)): never in roles made from "every permission", never by an access grant, never with user or role management, never self-appointed (`packages/db/drizzle/0086_speak_up.sql`, `0101_employee_relations_casework.sql`). Speaking up: only the Freedom to Speak Up lead and the members they name read a case, never the owner or the Registered Manager; the reporter of a named or confidential concern kept apart from the concern; an anonymous concern stores no account, IP address or device, its reply token only as a SHA-256; audit names no actor for raising or replying; left out of the free full export, and the lead's own export needs a fresh step-up and is audited with counts only (`apps/api/src/routes/speak-up.ts`); the anonymised view is held by no role until its screen exists ([ADR-0125](../decisions/0125-speak-up-anonymised-view-not-yet-granted.md)). Casework: read only by the members named on a case, its opener included; no role, grant or break-glass reaches it; the member of staff it is about is never a member; MFA on every route (`packages/domain/src/workforce/casework.ts`, `apps/api/src/routes/casework.ts`). Safeguarding log: the full log only for `safety.safeguarding.manage` within the permission's reach, staff caring for the person read only the protective measures, audit with opaque ids, not sent to devices (`apps/api/src/routes/safeguarding.ts`, `packages/db/drizzle/0075_safeguarding_log.sql`, HZ-126) |
| Open measures | What someone writes may still identify them: the guidance to reporters says so (H-722). The caseworker role is given through the operator or support for now (H-803), and a caseworker close to the colleague a case is about is for the case manager to manage (a declared-conflict check is planned with slice 58) |
| Expected residual | Remote, severe, **medium** (free text can identify a reporter whatever the system does) |
| DPO decides | Who holds the lead role and how it is reviewed (H-720); the reporter guidance (H-722); how a subject access request from someone named in a concern, case or allegation is handled, with the safeguarding and confidentiality exemptions (H-596, H-791). *Tenant completes*: name the Freedom to Speak Up lead and who holds the caseworker role |

#### R22 Clock-in location, NFC and lone-worker check-ins used to monitor staff beyond their purpose

| Field | Value |
| --- | --- |
| Slices | 30 time and attendance, 46 lone working and 71 the phone (all built) |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | Location and NFC evidence are off everywhere: the phone always sends a clock event with evidence `none` and sends no location with a lone-worker event (`apps/mobile/src/sync/shift-upload.ts`, `apps/mobile/src/scheduling/actions.ts`; [scheduling.md](../specs/scheduling.md) section 22.2). Clock evidence is never a position: a location's setting is `none` by default, and the API keeps `at_location` or an NFC tag only when that location's setting asks for it and the tag is one of its own short codes, otherwise it stores `none` and flags `evidence_not_matched` (`allowedEvidence` in `apps/api/src/routes/time-attendance.ts`, `packages/db/src/schema/time-attendance.ts`; section 16). Lone-worker location is off by default (`scheduling.lone_worker.location` in `packages/domain/src/platform/feature-flags.ts`); the API stores a point only when a device sends one and the flag is on for that location: one point attached to one event the worker sent, never a track, erased after `lone_worker.location_days` (30 days, to verify) by the lone-worker sweep (`apps/api/src/routes/lone-worker.ts`, `sweepLoneWorkersJob` in `apps/api/src/jobs/tasks.ts`; section 19.5). Check-ins are made by the worker, never inferred; monitors (`scheduling.lone_worker.monitor`, MFA) see a point only on an open alarm, as text with no map provider (H-1144), and which sessions and alarms they viewed is audited; a duress press is shown on the phone and audited as an ordinary check-in (HZ-125). Clock events are seen by the worker and the managers who build or approve the rota at the location; audit carries ids only. Nothing here is used to judge performance or timekeeping |
| Not built or off | NFC tags and location evidence at clock-in, and lone-worker location, wait for the employee-monitoring DPIA (H-527): no screen sets clock evidence, the phone cannot send it, and the API's clock setting asks the manager to confirm the DPIA is approved (`dpiaApproved`) rather than reading the signed DPIA |
| Expected residual | Remote, significant, **low** while evidence and location stay off; assessed again in the employee-monitoring DPIA before either is switched on (H-527) |
| DPO decides | The employee-monitoring DPIA, and whether location or NFC evidence is necessary and proportionate for each service type (H-527, H-792); that it covers lone working, its basis and retention (H-1033); the staff privacy notice (H-578). *Tenant completes*: explain monitoring to staff |

#### R23 A subject access bundle or disclosure that reveals third parties, misses records or goes beyond its legal basis

| Field | Value |
| --- | --- |
| Slices | 15 DSAR workbench, 41 disclosure requests, 18 (complainants as third parties); all built |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | One collector over the export catalogue with a subject map per table, used by both subject access and disclosure requests (`packages/domain/src/platform/dsar.ts`; [ADR-0090](../decisions/0090-dsar-workbench-and-disclosure-collector.md)); the case lists the tables it could not search; third-party names highlighted for the reviewer but never redacted or withheld on Thapsus Care's own: a person decides each record with a reason under DPA 2018 Schedules 2 to 4; a DSAR bundle issued only when every item has a decision, built when issued and never stored, with its SHA-256 recorded; erasure assessed against the retention schedule and left to the retention engine; `quality.dsar.manage` across the organisation with MFA; a closed case never changes (`apps/api/src/routes/dsar.ts`, `packages/db/drizzle/0077_dsar_workbench.sql`). Disclosure requests store the legal basis for their type; nothing is released until someone other than the requester approves it, with a fresh step-up; the pack is kept as a document with its SHA-256, given only through the recipient's secure route and never by ordinary email (`packages/domain/src/safety/disclosure.ts`, `apps/api/src/routes/disclosures.ts`, `packages/db/drizzle/0103_disclosure_requests.sql`, `0124_disclosure_hand_over.sql`, H-958). Every read and write audited with ids and counts |
| Open measures | Tables the collector cannot search are checked by hand ([dsar-procedure.md](dsar-procedure.md) step 6); the speaking-up and casework silos are answered by the lead and the case members, outside the workbench |
| Expected residual | Possible, significant, **medium** (depends on the reviewer's decisions) |
| DPO decides | The retention of DSAR cases (H-613) and the other workbench defaults (H-612 to H-615); the disclosure bases (H-592, H-821) and their retention (H-820); who reviews bundles; the exemptions the organisation relies on. *Tenant completes*: the DSAR procedure owner and who approves disclosures |

#### R24 A breach not assessed or reported within 72 hours, or a tenant not told by Thapsus as processor

| Field | Value |
| --- | --- |
| Slices | 20 (built) |
| Initial | Possible, severe, **high** |
| Measures built (evidence) | The register (`dp_breach`) with the ICO clock worked out on every read from `ico.breach.report_hours` ([platform.md](../specs/platform.md), breach register); `assessBreach` stores a suggestion as decision support only, and the decision goes through `checkBreachDecision` with reasoning (`packages/domain/src/platform/data-rights.ts`); a late report needs the reasons for the delay; a notice to the people affected drafted from Thapsus Care's template and refused while a prompt remains (`packages/domain/src/platform/breach-notice.ts`); Thapsus notifies the organisation only through `app.send_processor_breach_notice` (an active operator admin with a fresh sign-in), which opens the organisation's register entry and tells its data protection lead and owners urgently (`packages/db/drizzle/0082_breach_register.sql`, `apps/api/src/routes/operator-breach-notices.ts`); every read and change audited with ids and codes only; the register reached only with `quality.dsar.manage` across the organisation (`apps/api/src/routes/data-protection.ts`) |
| Open measures | Who at Thapsus sends notices and the contractual target (H-673) |
| Expected residual | Remote, severe, **medium** |
| DPO decides | Retention periods (`dp_breach` 6 years, recommended answer applied, H-670); the Article 9 condition (H-671); the notice template (H-672); the Thapsus contact and target in the data processing agreement (H-673). *Tenant completes*: who decides on reporting and who deputises |

#### R25 Payroll, vetting, learning and e-signature providers receiving staff or care data, possibly outside the UK

| Field | Value |
| --- | --- |
| Slices | 76 payroll exports, 77 vetting adapters, 78 learning platform imports, 79 e-signature and OCR, 86 to 90 the Thapsus-HR link (all built, every adapter off or a mock) |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | No adapter is on by default and only contract-tested mocks exist; production refuses the mocks at start, so no call leaves Thapsus Care (`apps/api/src/config.ts`). Payroll: a locked pay run leaves only when a holder of `finance.payroll.export` across the organisation exports it with step-up, as the minimum fields (payroll reference, hours, pay elements, total, holiday accrued, auto-enrolment category and qualifying earnings; no name, date of birth, NI number or bank detail; SSP only as an amount); file exports are downloaded by that person; each export recorded with its SHA-256 and the file never kept; the payroll provider is the organisation's own processor ([ADR-0097](../decisions/0097-payroll-and-pension-exports.md)); Xero only through a mock until assessed (`packages/domain/src/scheduling/payroll-export/payroll-export.ts`, `apps/api/src/routes/payroll-export.ts`, `apps/api/src/integrations/payroll/xero.ts`, H-1192). Vetting: off for every organisation, mock only, each port sending only its declared fields ([ADR-0094](../decisions/0094-vetting-and-identity-integrations.md), `apps/api/src/integrations/vetting.ts`). Learning platforms: the organisation's own processor; a file upload or a mock pull; names, emails and scores in a file ignored and never stored ([ADR-0102](../decisions/0102-learning-platform-imports.md), `apps/api/src/integrations/lms/learning-platform.ts`, H-1254). E-signature: in Thapsus Care by default, so nothing leaves; DocuSign off by default and refused in production until H-540, its envelope carrying only an organisation document, its hash, a generic subject and the signer's name and sign-in email. OCR: unavailable in production until the Document AI adapter in europe-west2 is built (H-1262); values read stay unconfirmed until a person decides each (HZ-005), and none reaches the audit trail, logs or events ([ADR-0095](../decisions/0095-ocr-and-e-signature-adapters.md), `apps/api/src/integrations/esign-ocr.ts`). Thapsus-HR link: connects only to a UK workspace over HTTPS, with step-up; matches by employee number, or work email with date of birth, never by name; names, email and date of birth read for matching are not stored; sickness comes in as dates and type only; pay goes out as units, never money; only a mock exists ([ADR-0126](../decisions/0126-thapsus-hr-link.md), `packages/domain/src/integrations/thapsus-hr.ts`, `apps/api/src/integrations/thapsus-hr.ts`) |
| Open measures | Each provider joins the sub-processor register or the organisation's own processor list, and this DPIA, before it is switched on; transfers only to the UK, or with an adequacy decision or the IDTA (H-520, H-793). Whether Thapsus-HR is a sub-processor of Thapsus Care or the organisation's own processor (H-1341) |
| Expected residual | Remote, significant, **low** while every adapter is off or a mock; assessed again for each provider before it is switched on (H-793) |
| DPO decides | Each provider before it is switched on (H-793), and that payroll and learning providers are the organisation's own processors (H-1192, H-1254); DocuSign (H-540); Document AI's terms (H-1262); Thapsus-HR's role (H-1341). *Tenant completes*: choose providers knowingly |

#### R26 Imported data inaccurate, excessive, or about people outside the service

| Field | Value |
| --- | --- |
| Slices | 26 (people, contacts, allergies, staff), 51 (medicines, care plans, staff files), 78 (training completions), 87 (matching to Thapsus-HR employees); all built |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | Only columns matched to a Thapsus Care field are kept; an upload with unmapped columns is refused until each is mapped or left out; staged rows in quarantine, never shown back, deleted at commit, discard or expiry (`import.staging_expiry_days`, 7 days, by the import expiry job) and left out of the full export; no error, log or audit event carries an imported value; matching against people already in the organisation never merges (HZ-130); people with allergies to record and allergy status unknown are reported in the dry run (HZ-007); imported medicines arrive "not yet checked" (HZ-005) and care plans as drafts; commit and undo need a fresh sign-in, and undo removes a commit whole within `import.undo_window_days`; only a member with the import permissions across the whole organisation may import, so matching never discloses a person at another home (`packages/domain/src/platform/imports.ts`, `imports-clinical.ts`, `apps/api/src/routes/platform-imports.ts`, `packages/db/drizzle/0088_import_wizard.sql`, `0136_clinical_imports.sql`, [ADR-0092](../decisions/0092-import-wizard.md)). Training imports keep only the learner id, course code and dates, linked to a member by a person. Thapsus-HR matches that are ambiguous or conflicting go to a person to review (`matchEmployee`) |
| Open measures | The tenant checks the source export and signs off a sample after committing (H-682) |
| Expected residual | Remote, significant, **low** |
| DPO decides | The staging period, retention and these measures (H-681); whether home-scoped importing is wanted (H-683). *Tenant completes*: who imports, and the sample check |

#### R27 An identity provider account linked to the wrong member, or sign-in without Thapsus Care's second factor

| Field | Value |
| --- | --- |
| Slices | 33 (built: OpenID Connect; SAML not built) |
| Initial | Possible, severe, **high** |
| Measures built (evidence) | Links only members the organisation already invited, never creates one; a domain counts only once proved by a DNS TXT record and can be verified by one organisation at a time; a provider's MFA claim is never read: an SSO session has no Thapsus Care factor, so care records and step-up ask for the passkey or authenticator code on that session (HZ-112); `private_key_jwt` only, with keys read from the managed secret store, never stored in the database; configuration needs `platform.tenant.manage` with step-up, audited without key names, tokens or domains (`packages/domain/src/platform/sso.ts`, `apps/api/src/routes/sso.ts`, `packages/db/drizzle/0095_single_sign_on.sql`, [ADR-0091](../decisions/0091-single-sign-on.md)) |
| Open measures | SAML (H-753); the identity provider is the organisation's own processor, not Thapsus's sub-processor (ADR-0091) |
| Expected residual | Remote, significant, **low** |
| DPO decides | The decisions logged with the slice (H-750 to H-755); whether the identity provider needs an entry in the organisation's own processor list. *Tenant completes*: the identity provider and its contract |

#### R28 A respondent identified from small-group staff survey results

| Field | Value |
| --- | --- |
| Slices | 44 (built) |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | Results show only once the survey has closed and at least `wellbeing.survey_min_group_size` people answered (Thapsus Care default 5, to verify); the size in force is the larger of Thapsus Care's figure and the organisation's own, so an organisation can raise it and never lower it, and with no figure in force results never show (`app.survey_min_group_size`); each question shows only when that many answered it; below the size no count, spread or text is shown. There is no breakdown, filter or export of responses (the export leaves them out). A scale's counts show all or none: none when any point was chosen by fewer than the size. A response holds no member, no creator and no time but the UK week; its id is random; it waits apart and is moved, shuffled, when the survey closes, and the audit records each response anonymously at the close; the application role cannot read responses. Only members on a staff file from before the survey opened answer, never its writer or the home's survey managers. Wellbeing check-ins are the member's own and a manager sees one only while it is shared; nothing is scored or used for a decision about a member (`packages/domain/src/scheduling/wellbeing/wellbeing.ts`, `apps/api/src/routes/wellbeing.ts`, `packages/db/drizzle/0115_staff_wellbeing.sql`; [scheduling.md](../specs/scheduling.md) section 20) |
| Open measures | Free text can identify its writer by what it says (staff are warned on the form). Comparing two overlapping surveys of the same people can narrow down answers. Until a survey closes, and in the write-ahead log, point-in-time backups and dead rows until vacuum, a waiting response sits in the same transaction as its participation row, which someone with direct database access (Thapsus operators, not the application) could link; operator access is logged and approved. A manager who sets up made-up members, with staff files, before a survey opens could still pad its respondents. Statement logging (pgAudit) must not record the answers given to the submission function. No job yet destroys wellbeing records at the end of `staff_wellbeing` (H-1081, H-1082) |
| Expected residual | Remote, significant, **low** |
| DPO decides | The smallest group shown and the basis (H-794, H-1080); the residual points above (H-1081); retention (H-1082). *Tenant completes*: whether to raise the smallest group shown; warn staff that free text can identify them |

#### R29 Applicants' data kept after an unsuccessful application or used beyond recruitment

| Field | Value |
| --- | --- |
| Slices | 23 (built) |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | Kept while an application is open, then 6 months after the last closes (`applicant.unsuccessful`), or the talent pool period the applicant agreed to when later (`applicant.talent_pool`, 12 months from consent, withdrawable); interview scores and panel notes never pass to the staff file, only the job, the Schedule 3 conditions and the start date; equality monitoring insert-only with a random id and the date only, read by nobody, counted only through `app.equality_monitoring_counts` with counts under 5 shown as "fewer than 5" and padding, timing and differencing refused; `workforce.recruitment.manage` with MFA; audit with ids and codes only (`packages/domain/src/workforce/recruitment.ts`, `apps/api/src/routes/recruitment.ts`, `packages/db/drizzle/0085_applicant_tracking.sql`) |
| Open measures | No scheduled job yet destroys applicant records at the end of their class (section 7B.5) |
| Expected residual | Remote, significant, **low** |
| DPO decides | Retention defaults (H-732); the equality questions (H-733); whether monitoring is in the tenant export (H-734); the applicant privacy notice (H-735); the smallest count shown (H-731) |

### 7B.4 Processing with no new risk id

- **Safeguarding log (slice 13)** and **complaints (slice 18)**: unauthorised access (R1), retention
  (R5) and sharing (R6) apply; the person an allegation is about is under R21 and complainants in a
  subject access request under R23. Clinical risk is in the hazard log (HZ-126).
- **Policy library (slice 25)**: staff signatures on policy versions only; R1 and R5.
- **Training, competence, supervision and e-learning (slices 17, 43 and 72)**: B3 records under R1
  and R5; the e-learning package sees the member's first name only, in a sandbox on a separate
  origin ([ADR-0093](../decisions/0093-elearning-runtime.md)); offline courses on the phone sit in
  the encrypted device database (R2).
- **Rota and bank and agency workers (slices 21 and 27)**: R1; an agency or bank worker's access
  comes from their booked shifts and ends at shift end plus `access.agency.post_shift_hours`
  ([ADR-0088](../decisions/0088-rota-derived-agency-access.md)).
- **Outbreaks (slice 31)** and **deaths and missing persons (slice 37)**: care records and
  statutory notifications under R1, R5, R6 and R17; the Herbert Protocol profile is prepared with
  the person and their family and says where any prefilled part came from.
- **Quality framework, audits, data security evidence and the dashboard (slices 14, 19, 32 and
  47)**: organisation data and counts; a count of 1 or more below `quality.indicator.min_group_size`
  is withheld (H-981).
- **Dependency tool (slice 12)**: categories chosen by staff from the organisation's own scale,
  never derived by Thapsus Care (B1; R1, R4).
- **Medicines (lane A)** and their copies on the phone (slice 68): B1 records under R1, R2, R4, R8
  and, for the printable MAR, R14; clinical risk is in the hazard log.

### 7B.5 Retention the DPO sets

From the plan's list (H-525) and [retention.md](../specs/retention.md), for the built slices, with
the recommended answers applied on 31/10/2026 for the DPO to review at the testing phase:

| Records (slice) | Class in the code | Open |
| --- | --- | --- |
| Staff file, HR-only documents, casework, induction and leavers, pay profiles, supervision (11, 29, 36, 39) | `staff_file`, the tenant's chosen option; right to work copies `right_to_work_copy` (2 years after employment ends) | DBS details (H-575); casework (H-806) |
| Sponsor records (35) | `sponsor_record` (2 years after employment ends) | H-901 |
| Vetting consents and checks (77) | `staff_file` | - |
| Training, competence, e-learning, imported training and read-and-sign (17, 25, 43, 78) | `training_record` | Read-and-sign (H-742) |
| Rota, agency, clock events, timesheets, pay runs and payroll export records (21, 27, 30, 36, 76) | `rota_and_timesheet`; working time results `working_time_record`, opt-outs `working_time_opt_out` | retention.md also lists a `payroll_export` class (6 years) that the code does not use |
| Absences, fit notes, return to work (40) | `sickness_absence` (6 years) | H-973 |
| Lone working (46) | `lone_worker` (3 years from the finish); location points erased after `lone_worker.location_days` (30 days) | H-1033; retention.md also lists a `lone_worker_check_in` class (3 months for routine check-ins) that the code does not use |
| Wellbeing (44) | `staff_wellbeing` (2 years) | H-1082 |
| Safeguarding log (13) | `serious_incident` | H-596 |
| DSAR cases (15) | `data_rights_case` (3 years) | H-613 |
| Breach register and Thapsus breach notices (20) | `dp_breach` (6 years from closure) | H-670 |
| Data protection complaints (20) | `data_rights_case` (3 years) | H-670 |
| Disclosure requests and packs (41) | `serious_incident` | H-820 |
| Unsuccessful applicants and the talent pool (23) | `applicant.unsuccessful` (6 months), `applicant.talent_pool` (12 months from consent) | H-732 |
| Speaking up (24) | `speak_up_concern` (6 years from closure) | H-721; retention.md also lists a `whistleblowing` class of the same period that the code does not use |
| Staff outbreak cases (31) | `outbreak_staff_case` (3 years from the outbreak's closure) | H-767 |
| Import batches (26, 51) | Staged rows at most 7 days; batch and commit records as audit | H-681 |
| OCR of scanned MAR charts (79) | `care_record`, with the image | - |
| Thapsus-HR links and delivery log (87 to 90) | Links with the staff file; delivery log 12 months | H-1341 |

The import expiry job and the lone-worker location erasure run on a schedule. No scheduled job yet
destroys the other Phase 2 records when their class ends; until it does, destruction past retention
is a person's action through the retention screens.

### 7B.6 Before this section is signed

| Item | Value |
| --- | --- |
| Slices merged since 7 November 2026, to add | *Thapsus Care updates the draft* |
| Lawful bases the records of processing do not yet name | Location and NFC evidence at clock-in, as employee monitoring (H-527); agency workers' records, whom the organisation does not employ (H-547); a wellbeing check-in the member keeps to themselves, which may reveal health (H-1080); health revealed in free text in induction, probation, exit interview and training records; the Thapsus-HR link as a purpose row of its own (H-1341). The plan's proposed purposes B17 (sponsor duties) and B18 (disclosure requests) are not rows in the records of processing: sponsor duties sit in B3 and disclosures in a note with a basis per type. *DPO completes* |
| Risk R30 for the Thapsus-HR link (wrong matching, out-of-date data, over-sharing), assigned in the plan and ADR-0126 | Not yet in section 6 or the prefill; until it is, R25, R26 and R1 cover the link. *DPO decides whether it is added* |
| R20 to R29 in sections 6 and 7 and in the in-app prefill | Done (H-795) |
| DPO review of this section | *DPO completes* (H-790) |
| Who reviewed section 7B, and when | *Tenant completes* |

## 8. Sign-off

| Item | Name and date | Notes |
| --- | --- | --- |
| Measures approved by | | Integrate actions into the project plan |
| Residual risks approved by | | If any high residual risk remains, consult the ICO before going ahead (Art 36) |
| DPO advice provided | | DPO advises on compliance, section 7 measures and whether processing can proceed |
| DPO advice accepted or overruled (with reasons) | | |
| Consultation responses reviewed | | |
| This DPIA will be kept under review by | | Review on any configuration change Thapsus Care flags, and at least annually |

---

## 9. AI addendum (required before the AI module is enabled)

The AI module is off by default. It is enabled per tenant only after this addendum is signed, a model provider is chosen and an accountable owner is named (master prompt 16). Guidance: [DHSC: using AI in adult social care](https://www.gov.uk/guidance/using-ai-in-adult-social-care).

| Item | Value |
| --- | --- |
| Accountable owner | *Tenant names* |
| Capabilities enabled | `{{ai.capabilities[]}}` (Ask Thapsus Care, summaries, drafting, compliance monitor explanations, inspection preparation, rota assistant, finance commentary, voice to text) |
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
| Basis | Consent (Art 6(1)(a); Art 9(2)(a) explicit consent where a photo or update reveals health), recorded per person and per family member, from the person or an attorney or deputy whose authority covers it. Under a best-interests decision: Art 6(1)(f) (6(1)(e) for a public body) with Art 9(2)(h) and DPA 2018 Sch 1 para 2 (H-106, H-38) |
| Delivery | Family email through the email provider (H-08) with no update content; delivery logs kept 12 months from sending; an opt-out kept while the address is held and deleted with the contact (H-106) |
| Consent process | *Tenant describes how consent is asked for, recorded, reviewed and withdrawn, including for people who lack capacity* |
| What families see | *Tenant lists the sections shared and who decides (sharing decisions, people.md rule 13)* |

## 11. Marketing (when marketing is switched on)

| Item | Value |
| --- | --- |
| Purpose | Records of processing B9: marketing to families and enquirers |
| Basis | Consent (Art 6(1)(a)), and PECR for electronic messages |
| Consent wording | *Tenant records the wording used* |
| Channels | *Tenant lists the channels and checks each against PECR* |
