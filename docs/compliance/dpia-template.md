# Data protection impact assessment: Harbour deployment template

**For**: each tenant (care provider), as controller. **Required because** the processing involves special category data about people who may be vulnerable, on a large scale, using new technology including offline mobile devices; these match the ICO's criteria for when a DPIA is needed ([ICO: when do we need to do a DPIA?](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/); UK GDPR Art 35).

**How it works**: Harbour pre-fills this template from the tenant's configuration. Merge fields are shown as `{{field}}` and are filled from the tenant record; Harbour re-generates the pre-filled sections when configuration changes and flags the DPIA for review. The tenant's DPO or named lead completes the remaining sections and **signs it in-app before go-live** (master prompt 5.1); the signer cannot be one of the people who prepared that version, and a risk still high after its measures needs the ICO's prior consultation reference first. A signed DPIA falls due for review when a purpose, sub-processor, data category or module appears that it did not cover, and yearly. Enabling the AI module requires the AI addendum (section 9) to be signed first (master prompt 16); the family portal and marketing add sections 10 and 11. Rules: [platform-completions.md](../specs/platform-completions.md) rules 17 to 22, `packages/domain/src/platform/dpia.ts`. Section 7A covers the Phase 1 residential care processing (risks R13 to R19), added 31 October 2026 for the Phase 1 gate. Section 7B is a first draft of the Phase 2 processing built so far (risks R20 to R29), not yet signed or in the in-app prefill.

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

R1 to R8 apply to every tenant; R9 to R12 only with the processing named in the row; R13 to R19 are the Phase 1 residential processing every tenant has (section 7A lists which risks apply to each kind of processing); R20 to R29 are the Phase 2 processing (section 7B, a first draft; R22, R25 and R28 cover processing still being built, and a tenant records in section 7B.6 what it does not use). A DPIA signed before a standard risk was added is flagged for review. Harbour fills this table from `packages/domain/src/platform/dpia.ts`, and a test (`dpia.test.ts`) fails if an id or its wording differs from this table.

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
| R27 | An identity provider account linked to the wrong member, or sign-in without Harbour's second factor | Possible | Severe | High |
| R28 | A respondent identified from small-group staff survey results | Possible | Significant | Medium |
| R29 | Applicants' data kept after an unsuccessful application or used beyond recruitment | Possible | Significant | Medium |
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
| R13 | People in the request's scope only; third parties and staff by role; identifiers and unreviewed free text withheld; a recipient-bound link with a one-time code sent to the recipient's work email, an expiry and revocation; the bundle deleted when the link ends; every open audited (section 7A) | Check the recipient and their work email; release only what the request needs; revoke when the inspection ends | Reduced | | |
| R14 | Full export: owner only, fresh sign-in with MFA, one download then deleted. Downtime pack: fresh sign-in, hourly limit, PDF never stored, no photos printed, kiosk copy encrypted. Transfer pack: printed from a stored snapshot, each print audited with the hospital named (section 7A) | Where a downloaded export is kept and who holds it; secure storage and shredding of printed packs; transfer packs handed over in person | Reduced | | |
| R15 | Search only where the searcher's permissions and scope reach, MFA for care records, audit without the words typed; break-glass with a typed reason, alerts to the Registered Manager and the data protection lead, a daily search limit and the weekly report (section 7A) | Review the weekly break-glass report; act on misuse | Reduced | | |
| R16 | Approved templates never approved by their author; recipient limited to the person or their own contacts; NHS number, date of birth and special category fields never in an email; incident and candour letters by letter only (section 7A) | Approve template wording; keep contacts' addresses current | Reduced | | |
| R17 | Notifications and deadlines worked out from the incident's answers, overdue escalation, submission only by holders of `safety.notification.submit` after a fresh sign-in, raiser cannot close (section 7A) | Name who submits; check each form before it is sent | Reduced | | |
| R18 | Capacity test in the Act's words, authority checked against the contact's legal authority, best-interests checklist, DoLS expiry reminders, every version kept (section 7A) | Mental Capacity Act policy and training; DoLS applications and reviews on time | Reduced | | |
| R19 | Invented sample people only, flagged, badged, watermarked, left out of the full export (not yet of statutory notifications: a draft about a sample person is decided not required, H-452), removed as a batch (section 7A) | Remove sample data before go-live | Reduced | | |
| R20 | Staff file permissions of their own (owner and HR by default), MFA, row-level security, HR-only documents hidden from everyone without `workforce.hr_document.read` and every open audited, no DBS certificate copy kept (section 7B) | Who holds HR access; the appropriate policy document; retention of staff files | Reduced | | |
| R21 | Speaking up in a silo the owner and managers cannot read, anonymous concerns with no identity stored, audit without the reporter; the safeguarding log for its managers only, carers see protective measures only (section 7B) | Name the Freedom to Speak Up lead; guidance to reporters | Reduced | | |
| R22 | Planned: location only at the clock-in or check-in itself, scoped like the shift, its own retention (section 7B; not built) | Explain monitoring to staff | Planned | | |
| R23 | Subject map over every table, third-party names highlighted but decided by a person with a reason, bundle built when issued and never stored, its SHA-256 recorded (section 7B) | Review each record before the bundle is issued | Reduced | | |
| R24 | ICO clock worked out on every read, decision with reasoning, late reports need reasons, Thapsus notices open the register entry and tell the data protection lead (section 7B) | Name who decides on reporting and who deputises | Reduced | | |
| R25 | Planned: no adapter on by default; each provider assessed and in the sub-processor register before it receives data (section 7B; not built) | Choose providers knowingly | Planned | | |
| R26 | Only mapped columns kept, staged rows in quarantine and deleted at commit, discard or expiry, matching never merges, undo of a whole commit, organisation-wide importers only (section 7B) | Check the source export; sign off a sample after committing | Reduced | | |
| R27 | Links only invited members, DNS-proved domains, Harbour's own second factor still asked for care records and step-up, keys in the managed store only (section 7B) | The identity provider and its contract | Reduced | | |
| R28 | Planned: results only above a minimum group size, small counts suppressed (section 7B; not built) | Set the smallest group shown | Planned | | |
| R29 | Unsuccessful applicants kept 6 months (talent pool by consent), interview notes never passed to the staff file, equality monitoring kept apart and counted with small counts suppressed (section 7B) | Applicant privacy notice; the equality questions | Reduced | | |

## 7A. Phase 1 processing: residential care records

What Harbour's Phase 1 (residential care records) does with personal data, the risks in section 6 that apply to each kind of processing, the measures built, the residual risk Harbour expects once both Harbour's and the tenant's measures are in place, and what the tenant, as controller, must decide or sign off. The tenant rates the residual risk for each risk id in section 7; the expected level here is guidance, not the rating. Fields marked *Tenant completes* are the provider's own.

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
| Family feed and portal | R6, R11, R16 | Only sections a sharing decision covers, checked on every read (`packages/domain/src/people/sharing.ts`, `packages/domain/src/comms/feed-visibility.ts`, HZ-022); composing refuses other residents' and staff names and holds publishing while an incident about the person is open (`packages/domain/src/comms/feed-compose.ts`, `feed-text.ts`, HZ-061); notifications carry a generic line and a link only ([ADR-0060](../decisions/0060-family-notification-channels.md), HZ-060); the portal reaches only the family member's own rows ([ADR-0061](../decisions/0061-family-portal-scope-and-row-level-security.md)); photos only under consent or a best-interests decision, taken down when it ends (`photoItemsToWithdraw`); family email through SES in London (eu-west-2); notification delivery logs kept 12 months (H-106) | Medium | The sharing policy; the feed defaults (H-107); section 10. *Tenant completes* |
| Break-glass (opening a record and searching) | R1, R15 | A typed reason and a reason code; an alert to the Registered Manager and the data protection lead, and an audited record when no one could be told; a daily limit on break-glass searches, which show identity only and exact matches; the weekly report (`apps/api/src/routes/break-glass-search.ts`, `apps/api/src/routes/break-glass-report.ts`, `packages/domain/src/people/break-glass-report.ts`, `apps/api/test/break-glass-search.test.ts`) | Medium: depends on the weekly review | Who reviews the weekly report, and what happens on misuse. *Tenant completes* |
| Search | R15 | `platform.search.use`; each kind of record searched only where the searcher's permissions and scope reach, with MFA for care records; the audit keeps what was shown, never the words typed (`packages/domain/src/platform/search.ts`, `apps/api/src/routes/search.ts`, `apps/api/test/search.test.ts`, HZ-011) | Low | The search copies in backups (H-380). Search audit events that showed no person are kept 6 months as `security_log` (H-121) |
| Full export | R14 | The owner only, after a fresh sign-in with MFA; one download, then the archive is deleted; an expiry; secret and internal columns never leave; sample people left out (`packages/domain/src/platform/export.ts`, `export-catalogue.ts`, `apps/api/src/routes/exports.ts`, [platform-completions.md](../specs/platform-completions.md) rules 10 to 16, HZ-070, HZ-071) | Medium: once downloaded, the copy is the tenant's to protect | Who may ask for an export; where a downloaded export is kept and when it is destroyed; the expiry (H-118). *Tenant completes* |
| Inspector evidence packs and their links | R13 | Minimised by rule: people in scope only, third parties and staff by role, identifiers withheld, free text withheld until redacted by hand; a recipient-bound link with a one-time code sent to the recipient's work email, an expiry and revocation; the bundle deleted when the link ends; watermarked; every open audited (`packages/domain/src/quality/evidence-pack.ts`, `apps/api/src/routes/evidence-packs.ts`, `apps/api/src/routes/evidence-link.ts`, [ADR-0050](../decisions/0050-evidence-pack-links.md), HZ-050); retention `evidence_pack` | Low | The basis, redaction rules and defaults (H-96, H-217, H-218); who may release a pack. *Tenant completes* |
| Downtime packs and outages | R2, R14 | A fresh sign-in and an hourly limit to build or print; the PDF drawn on request and never stored; no photos printed; the kiosk copy encrypted and opened only in a PIN session of a holder of `operations.downtime.read` (`packages/domain/src/operations/downtime-pack.ts`, `kiosk-cache.ts`, `apps/api/src/routes/operations.ts`, [kiosk.md](kiosk.md), HZ-021); retention `downtime_pack` (one month) | Medium: printed copies are outside Harbour | Secure storage and shredding of printed packs in the business continuity plan; the downtime defaults (H-98). *Tenant completes* |
| Sample data | R19 | Invented people only (999-range NHS numbers, `example.invalid` emails), flagged and badged, watermarked or marked "Sample" on print, left out of the full export (not yet of statutory notifications, H-452), removed as a batch (`packages/domain/src/platform/sample-data.ts`, `apps/api/src/routes/sample-data.ts`, HZ-072) | Low | Remove sample data before go-live; the sample telephone numbers (H-123) |
| Offline devices and held entries | R2, R8 | Device copies encrypted with SQLCipher and wiped at sign-out, remote sign-out or revocation; the offline window set in the signed sync token; entries unsent at sign-out held for their owner only, and deleted only with a coded reason that is audited (`packages/sync/src`, `apps/api/src/routes/sync.ts`, `devices.ts`, `refused-entries.ts`, `packages/domain/src/care/discard-reasons.ts`, [ADR-0011](../decisions/0011-offline-window-and-kiosk-lock.md), [ADR-0029](../decisions/0029-mobile-offline-stack.md), HZ-040, HZ-110, [care.md](../specs/care.md) section 6) | Medium | MDM enrolment and lost-device reporting; the interim device positions (H-68). *Tenant completes* |
| Letters and emails from templates | R16 | Approved templates only, never approved by their author; the recipient is the person or one of their own contacts; NHS number, date of birth and special category fields never in an email; incident and candour letters by letter only (`packages/domain/src/comms/templates.ts`, `apps/api/src/routes/letters.ts`, `letter-templates.ts`, [ADR-0051](../decisions/0051-personal-data-in-template-emails.md), HZ-051) | Low | Approving the templates; keeping contacts' addresses current; the email connection (H-356). *Tenant completes* |

### 7A.3 Tenant's local notes

| Item | Value |
| --- | --- |
| Phase 1 processing the tenant does not use (and why) | *Tenant completes* |
| Local risks added in section 6 | *Tenant completes* |
| Who reviewed section 7A, and when | *Tenant completes* |

## 7B. Phase 2 processing: workforce, rights and safety (first draft)

**Status: first draft for the DPO, not signed and not approved.** Written 31 October 2026 for plan
slice 84 ([phase-2.md](../plans/phase-2.md)). It covers only the Phase 2 slices built so far, each
with a pull request open or merged: 11 staff file (#151), 13 safeguarding log (#155), 15 DSAR
workbench (#149), 18 complaints (#152), 20 breach register (#156), 23 applicants
(`feat/work-applicant-tracking`), 24 speaking up (`feat/safety-speak-up`), 25 policy library
(#154), 26 import wizard (#150) and 33 single sign-on (`feat/platform-sso`). Evidence paths name
files on those branches; a path is on `main` only once its pull request merges. Risks R22, R25 and
R28 belong to slices not built yet (30, 46 and 71; 76 to 79; 44): they are listed so the DPO sees
the whole set, with the measures each slice is planned to carry, and are assessed again when those
slices land.

R20 to R29 are in sections 6 and 7 and in the in-app prefill (`packages/domain/src/platform/dpia.ts`
and its test), as Phase 1 did for R13 to R19. A DPIA signed before they were added is flagged for
review (`dpiaReviewTriggers`, `new_standard_risk`); a basis saved before standard risks were
recorded counts as covering R1 to R8 only, so it is flagged for R13 to R29. The expected
residual levels below are Harbour's guidance, not the tenant's rating; fields marked *Tenant
completes* are the provider's own.

### 7B.1 Lawful bases

Taken from the records of processing on each branch ([records-of-processing.md](records-of-processing.md)).
Every basis here is a proposal until the DPO confirms it (H-526, H-790).

| Processing | Article 6 basis | Article 9 or Article 10 condition |
| --- | --- | --- |
| Staff file and pre-employment checks (B3; slice 11) | Art 6(1)(b) contract of employment; 6(1)(c) where a law requires the record (regulation 19 and Schedule 3 of the 2014 Regulations; Immigration, Asylum and Nationality Act 2006 for right to work) | Health: Art 9(2)(b) with DPA 2018 Sch 1 para 1. Criminal offence data (DBS): Art 10 with DPA 2018 s.10(5), Sch 1 para 1 and para 18. Both need the provider's appropriate policy document (H-576) |
| Safeguarding log (B4; slice 13) | Art 6(1)(ea) recognised legitimate interest, or 6(1)(c) or (e) for a public body | Art 9(2)(g) with Sch 1 para 18, with an appropriate policy document; Art 10 where a concern alleges a crime |
| Data subject requests (B5 and B13; slice 15) | Art 6(1)(c): the controller's duties under UK GDPR Articles 12 to 22 | Indirect: a bundle carries the subject's own special category data to them |
| Complaints and compliments (B14; slice 18) | Complaints: Art 6(1)(c), Regulation 16. Compliments: Art 6(1)(f) | Art 9(2)(h) with Sch 1 para 2 where a complaint or compliment reveals health (B14, a purpose of its own, H-700) |
| Breach register and data protection complaints (B13; slice 20) | Art 6(1)(c) (UK GDPR Arts 33 and 34; the duty to handle data protection complaints) | Art 9(2)(g) with Sch 1 para 6 where a description reveals health (DPO to confirm, H-671) |
| Applicants and recruitment (B15; slice 23) | Art 6(1)(b) steps before a contract and 6(1)(f); talent pool Art 6(1)(a) consent, withdrawable | Equality monitoring only: Art 9(2)(g) with Sch 1 para 8, voluntary, kept apart, reported as suppressed counts (H-576) |
| Whistleblowing and speaking up (B16; slice 24) | Art 6(1)(f) (protecting workers under the Public Interest Disclosure Act 1998, and safe care); 6(1)(e) for a public body | Art 9(2)(b) with Sch 1 para 1, or 9(2)(h) with Sch 1 para 2 where a concern reveals health; Art 10 with Sch 1 para 10 where it alleges a crime |
| Policy read-and-sign (B3 and B6; slice 25) | Art 6(1)(b) or (c) (staff compliance records) | None |
| Import of records from a previous system (slice 26) | The basis of the records imported (B1 for people; B2 and B3 as those imports land); no new purpose | As the records imported |
| Single sign-on links (B3 and B5; slice 33) | Art 6(1)(b) and (f) (authenticating staff for employment and security) | None |

### 7B.2 Which risks apply to which processing

| Slice and processing | Risks (section 6 and below) |
| --- | --- |
| 11 Staff file and pre-employment checks | R20, R1, R5 |
| 13 Safeguarding log | R21 (the person an allegation is about), R1, R5, R6 |
| 15 DSAR workbench | R23, R5 |
| 18 Complaints and compliments | R1, R5, R23 (complainants as third parties in a DSAR) |
| 20 Breach register and data protection complaints | R24 |
| 23 Applicants and recruitment | R29, R20 (a hired applicant's checks) |
| 24 Whistleblowing and speaking up | R21 |
| 25 Policy library and read-and-sign | No new risk: staff signatures only, under R1 and R5 |
| 26 Import wizard | R26, R4, R3 |
| 33 Single sign-on | R27, R1 |
| 30, 46, 71 Clock-in and lone-worker check-ins (not built) | R22 |
| 76 to 79 Payroll, vetting, learning and e-signature adapters (not built) | R25, R7 |
| 44 Wellbeing surveys (not built) | R28 |

### 7B.3 Risks R20 to R29

Likelihood, severity and overall use the scale in section 6. "Initial" is before Harbour's
measures; "expected residual" is with Harbour's measures built and the tenant's in place.

#### R20 Staff vetting and employment records (DBS and criminal offence data, right to work and immigration, health declarations, fit notes) seen beyond HR or kept too long

| Field | Value |
| --- | --- |
| Slices | 11 (built), 23 (a hired applicant's checks; built), 29, 35, 36 and 40 (not built) |
| Initial | Possible, severe, **high** |
| Measures built (evidence) | Four permissions of their own (`workforce.staff_file.read`, `.manage`, `workforce.hr_document.read`, `workforce.dbs_risk_assessment.sign`), owner and HR by default (`docs/specs/workforce.md` section 3); forced row-level security on `staff_profile` and `compliance_item`, read by holders and by the worker for their own file only, never written on one's own file (migration 0073); HR-only documents hidden by the `document_hr_only` policy from everyone without `workforce.hr_document.read`, never served by the general document routes, never found by search, and every open audited as `workforce.hr_document.viewed` (`apps/api/src/routes/staff-files.ts`); no DBS certificate copy and no right to work share code kept, only the details each Schedule 3 rule needs (`packages/domain/src/workforce/staff-file.ts`); expiry reminder tasks with opaque ids and a generic title; MFA for the staff file and recruitment permissions; right to work copies as `right_to_work_copy` (2 years after employment ends) |
| Open measures | HR-only documents use `staff_file`, whose rule row (the tenant's choice of `staff_file.*` and the leaving-date trigger) is not in the retention engine yet, so nothing destroys them yet (slice 11 changelog); HR's inbox cannot see reminder tasks until the task visibility rule learns `required_permission` (slice 17) |
| Expected residual | Possible, significant, **medium** until the retention rule runs; then remote, significant, **low** |
| DPO decides | What of a DBS check is kept and for how long (H-575); the appropriate policy document for health and criminal offence data (H-576); the default holders of the new permissions (H-577); the staff privacy notice (H-578); retention of the staff file as the tenant selects (H-525). *Tenant completes*: who holds HR access at each home |

#### R21 The identity of a whistleblower or the subject of a case disclosed, or a silo reached by a wider role

| Field | Value |
| --- | --- |
| Slices | 24 (built), 13 (the person a safeguarding allegation is about; built), 39 casework (not built) |
| Initial | Possible, severe, **high** |
| Measures built (evidence) | Speaking up in a silo (ADR-0089 (`docs/decisions/0089-restricted-silos-whistleblowing.md`) on `feat/safety-speak-up`): `safety.speak_up.manage` carried only by the built-in `speak_up_guardian` role, never by roles made from "every permission", never by an access grant, never with user or role management, never self-appointed (guards in migration 0086); only the Freedom to Speak Up lead and the members they name read a case, never the owner or the Registered Manager; the reporter of a named or confidential concern kept apart from the concern; an anonymous concern stores no account, IP address or device, its reply token only as a SHA-256; audit names no actor for raising or replying, no outbox event, no `record_version` copies; left out of the free full export (`apps/api/src/routes/speak-up.ts`, `packages/db/test/speak-up.test.ts`). Safeguarding log: the full log only for `safety.safeguarding.manage` within the permission's reach, staff caring for the person read only the protective measures, audit with opaque ids, not sent to devices (`apps/api/src/routes/safeguarding.ts`, migration 0075, HZ-126) |
| Open measures | What someone writes may still identify them: the guidance to reporters says so (H-722); the lead's separate export and a whistleblowing retention class (H-721); casework (slice 39) builds its own silo on ADR-0089 |
| Expected residual | Remote, severe, **medium** (free text can identify a reporter whatever the system does) |
| DPO decides | Who holds the lead role and how it is reviewed (H-720); retention and the lead's export (H-721); the reporter guidance (H-722); how a subject access request from someone named in a concern or allegation is handled, with the safeguarding and confidentiality exemptions (H-596, H-791). *Tenant completes*: name the Freedom to Speak Up lead |

#### R22 Clock-in location, NFC and lone-worker check-ins used to monitor staff beyond their purpose

| Field | Value |
| --- | --- |
| Slices | 30, 46 and 71 (not built) |
| Initial | Possible, significant, **medium** |
| Measures planned | Location recorded only at the clock-in or check-in itself, never tracked between; scoped like the shift record; a retention class of its own for lone-worker check-ins (H-525); explained to staff in the staff privacy notice (H-578). Assessed again when the slices are built |
| Expected residual | To be assessed |
| DPO decides | Whether location at clock-in is necessary and proportionate for each service type; the retention period (H-792) |

#### R23 A subject access bundle or disclosure that reveals third parties, misses records or goes beyond its legal basis

| Field | Value |
| --- | --- |
| Slices | 15 (built), 18 (complainants as third parties; built), 41 disclosure requests (not built) |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | The subject map over the export catalogue finds every table that refers to the subject (`packages/domain/src/platform/dsar.ts`, ADR-0090 (`docs/decisions/0090-dsar-workbench-and-disclosure-collector.md`) on `feat/platform-dsar-workbench`); third-party names highlighted for the reviewer but never redacted or withheld on Harbour's own: a person decides each record with a reason under DPA 2018 Schedules 2 to 4; the bundle issued only when every item has a decision, withheld items counted, and built from the records when issued, never stored, with its SHA-256 recorded; erasure assessed against the retention schedule and left to the retention engine; `quality.dsar.manage` across the organisation with MFA; every read and write audited with ids and counts; a closed case never changes (migration 0077); retention `data_rights_case` (3 years from closure) |
| Open measures | Tables the subject map does not search are listed in [dsar-procedure.md](dsar-procedure.md) step 6 for a manual search; the speaking-up silo is outside the workbench by design (H-721) |
| Expected residual | Possible, significant, **medium** (depends on the reviewer's decisions) |
| DPO decides | The retention of DSAR cases (H-613) and the other workbench defaults (H-612 to H-615); who reviews bundles; the exemptions the organisation relies on. *Tenant completes*: the DSAR procedure owner |

#### R24 A breach not assessed or reported within 72 hours, or a tenant not told by Thapsus as processor

| Field | Value |
| --- | --- |
| Slices | 20 (built) |
| Initial | Possible, severe, **high** |
| Measures built (evidence) | The register (`dp_breach`) with the ICO clock worked out on every read from `ico.breach.report_hours` (`docs/specs/platform.md` rules 18 to 26 on `feat/platform-breach-register`); `assessBreach` stores a suggestion as decision support only, and the decision goes through `checkBreachDecision` with reasoning; a late report needs the reasons for the delay; a notice to the people affected drafted from Harbour's template and refused while a prompt remains (`breach-notice.ts`); Thapsus notifies the organisation only through `app.send_processor_breach_notice` (an active operator admin with a fresh sign-in), which opens the organisation's register entry and tells its data protection lead and owners urgently (migration 0082); every read and change audited with ids and codes only; the register reached only with `quality.dsar.manage` across the organisation |
| Open measures | Retention of the register is interim `audit_event` (H-670); who at Thapsus sends notices and the contractual target (H-673) |
| Expected residual | Remote, severe, **medium** |
| DPO decides | Retention periods (H-670); the Article 9 condition and the B13 rows (H-671); the notice template (H-672); the Thapsus contact and target in the data processing agreement (H-673). *Tenant completes*: who decides on reporting and who deputises |

#### R25 Payroll, vetting, learning and e-signature providers receiving staff or care data, possibly outside the UK

| Field | Value |
| --- | --- |
| Slices | 76, 77, 78 and 79 (not built) |
| Initial | Possible, significant, **medium** |
| Measures planned | No adapter on by default; each provider joins the sub-processor register and this DPIA before it receives data (H-520 to H-522, H-540); only the fields each provider needs; transfers only to the UK or with an adequacy decision or the IDTA. Assessed again when the adapters are built |
| Expected residual | To be assessed |
| DPO decides | Each provider before it is switched on (H-793) |

#### R26 Imported data inaccurate, excessive, or about people outside the service

| Field | Value |
| --- | --- |
| Slices | 26 (built: people first), 51 (medicines, care plans, staff files, TUPE; not built) |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | Only columns matched to a Harbour field are kept; an upload with unmapped columns is refused until each is mapped or left out; staged rows in quarantine, never shown back, deleted at commit, discard or expiry (`import.staging_expiry_days`, 7 days) and left out of the full export; no error, log or audit event carries an imported value; matching against people already in the organisation never merges (HZ-130); people with allergies to record and allergy status unknown are reported in the dry run (HZ-007); commit and undo need a fresh sign-in, and undo removes a commit's people whole within `import.undo_window_days`; only a member with the import permissions across the whole organisation may import, so matching never discloses a person at another home (`packages/domain/src/platform/imports.ts`, `apps/api/src/routes/platform-imports.ts`, migration 0088, ADR-0092 (`docs/decisions/0092-import-wizard.md`) on `feat/platform-import-wizard`) |
| Open measures | The tenant checks the source export and signs off a sample after committing (H-682) |
| Expected residual | Remote, significant, **low** |
| DPO decides | The staging period, retention and these measures (H-681); whether home-scoped importing is wanted (H-683). *Tenant completes*: who imports, and the sample check |

#### R27 An identity provider account linked to the wrong member, or sign-in without Harbour's second factor

| Field | Value |
| --- | --- |
| Slices | 33 (built: OpenID Connect; SAML later) |
| Initial | Possible, severe, **high** |
| Measures built (evidence) | Links only members the organisation already invited, never creates one; a domain counts only once proved by a DNS TXT record and can be verified by one organisation at a time; a provider's MFA claim is never read: an SSO session has no Harbour factor, so care records and step-up ask for the passkey or authenticator code on that session (HZ-112); `private_key_jwt` only, with keys read from the managed secret store, never stored in the database; configuration needs `platform.tenant.manage` with step-up, audited without key names, tokens or domains (`packages/domain/src/platform/sso.ts`, `apps/api/src/routes/sso.ts`, migration 0095, ADR-0091 (`docs/decisions/0091-single-sign-on.md`) on `feat/platform-sso`) |
| Open measures | SAML (H-753); the identity provider is the organisation's own processor, not Thapsus's sub-processor (ADR-0091) |
| Expected residual | Remote, significant, **low** |
| DPO decides | The decisions logged with the slice (H-750 to H-755); whether the identity provider needs an entry in the organisation's own processor list. *Tenant completes*: the identity provider and its contract |

#### R28 A respondent identified from small-group staff survey results

| Field | Value |
| --- | --- |
| Slices | 44 (not built) |
| Initial | Possible, significant, **medium** |
| Measures planned | Results only above a minimum group size, with small counts suppressed, as the applicants' equality monitoring already does (H-731); no free text shown against a small group. Assessed again when the slice is built |
| Expected residual | To be assessed |
| DPO decides | The smallest group shown (H-794) |

#### R29 Applicants' data kept after an unsuccessful application or used beyond recruitment

| Field | Value |
| --- | --- |
| Slices | 23 (built) |
| Initial | Possible, significant, **medium** |
| Measures built (evidence) | Kept while an application is open, then 6 months after the last closes (`applicant.unsuccessful`), or the talent pool period the applicant agreed to when later (`applicant.talent_pool`, 12 months from consent, withdrawable); interview scores and panel notes never pass to the staff file, only the job, the Schedule 3 conditions and the start date; equality monitoring insert-only with a random id and the date only, read by nobody, counted only through `app.equality_monitoring_counts` with counts under 5 shown as "fewer than 5" and padding, timing and differencing refused; `workforce.recruitment.manage` with MFA; audit with ids and codes only (`packages/domain/src/workforce/recruitment.ts`, `apps/api/src/routes/recruitment.ts`, migration 0085 on `feat/work-applicant-tracking`) |
| Open measures | The retention engine's destruction of applicant records runs with the retention rows above (DPO to confirm) |
| Expected residual | Remote, significant, **low** |
| DPO decides | Retention defaults (H-732); the equality questions (H-733); whether monitoring is in the tenant export (H-734); the applicant privacy notice (H-735); the smallest count shown (H-731) |

### 7B.4 Processing with no new risk id

- **Safeguarding log (slice 13)** and **complaints (slice 18)**: unauthorised access (R1), retention
  (R5) and sharing (R6) apply; the person an allegation is about is under R21 and complainants in a
  subject access request under R23. Clinical risk is in the hazard log (HZ-126).
- **Policy library (slice 25)**: staff signatures on policy versions only; R1 and R5.

### 7B.5 Retention gaps the DPO sets

From the plan's list (H-525), for the built slices, with the recommended answers applied on
31/10/2026 for the DPO to review at the testing phase ([retention.md](../specs/retention.md)): DBS
certificate details (11; with the staff file, no certificate copy, H-575), safeguarding (13;
`serious_incident`, H-596), DSAR cases (15; `data_rights_case`, 3 years, H-613), the breach
register and Thapsus breach notices (20; `dp_breach`, 6 years from closure, H-670), data
protection complaints (20; `data_rights_case`, 3 years, H-670), unsuccessful applicants (23; 6
months after the last application closes) and the talent pool (H-732), whistleblowing (24;
`whistleblowing`, 6 years from closure, replacing the interim `complaint`, H-721), read-and-sign
records (25; H-742) and import batches (26; staged rows at most 7 days, batch and commit records as
audit, H-681). Classes are also set for slices not built yet: medicines stock, disposal and
temperature logs, audits, staff surveys, lone-worker check-ins, sponsor records and payroll exports
(H-525).

### 7B.6 Before this section is signed

| Item | Value |
| --- | --- |
| Slices built since this draft, to add | *Harbour updates the draft* |
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
| Basis | Consent (Art 6(1)(a); Art 9(2)(a) explicit consent where a photo or update reveals health), recorded per person and per family member, from the person or an attorney or deputy whose authority covers it. Under a best-interests decision: Art 6(1)(f) (6(1)(e) for a public body) with Art 9(2)(h) and DPA 2018 Sch 1 para 2 (H-106, H-38) |
| Delivery | Family email through Amazon SES in London (eu-west-2) with no update content; delivery logs kept 12 months from sending; an opt-out kept while the address is held and deleted with the contact (H-106) |
| Consent process | *Tenant describes how consent is asked for, recorded, reviewed and withdrawn, including for people who lack capacity* |
| What families see | *Tenant lists the sections shared and who decides (sharing decisions, people.md rule 13)* |

## 11. Marketing (when marketing is switched on)

| Item | Value |
| --- | --- |
| Purpose | Records of processing B9: marketing to families and enquirers |
| Basis | Consent (Art 6(1)(a)), and PECR for electronic messages |
| Consent wording | *Tenant records the wording used* |
| Channels | *Tenant lists the channels and checks each against PECR* |
