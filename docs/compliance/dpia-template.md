# Data protection impact assessment: Harbour deployment template

**For**: each tenant (care provider), as controller. **Required because** the processing involves special category data about people who may be vulnerable, on a large scale, using new technology including offline mobile devices; these match the ICO's criteria for when a DPIA is needed ([ICO: when do we need to do a DPIA?](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/); UK GDPR Art 35).

**How it works**: Harbour pre-fills this template from the tenant's configuration. Merge fields are shown as `{{field}}` and are filled from the tenant record; Harbour re-generates the pre-filled sections when configuration changes and flags the DPIA for review. The tenant's DPO or named lead completes the remaining sections and **signs it in-app before go-live** (master prompt 5.1); the signer cannot be one of the people who prepared that version, and a risk still high after its measures needs the ICO's prior consultation reference first. A signed DPIA falls due for review when a purpose, sub-processor, data category or module appears that it did not cover, and yearly. Enabling the AI module requires the AI addendum (section 9) to be signed first (master prompt 16); the family portal and marketing add sections 10 and 11. Rules: [platform-completions.md](../specs/platform-completions.md) rules 17 to 22, `packages/domain/src/platform/dpia.ts`. Section 7A covers the Phase 1 residential care processing (risks R13 to R19), added 31 October 2026 for the Phase 1 gate.

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

R1 to R8 apply to every tenant; R9 to R12 only with the processing named in the row; R13 to R19 are the Phase 1 residential processing every tenant has (section 7A lists which risks apply to each kind of processing). Harbour fills this table from `packages/domain/src/platform/dpia.ts`, and a test (`dpia.test.ts`) fails if an id or its wording differs from this table.

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
| R19 | Invented sample people only, flagged, badged, watermarked, left out of exports and notifications, removed as a batch (section 7A) | Remove sample data before go-live | Reduced | | |

## 7A. Phase 1 processing: residential care records

What Harbour's Phase 1 (residential care records) does with personal data, the risks in section 6 that apply to each kind of processing, the measures built, the residual risk Harbour expects once both Harbour's and the tenant's measures are in place, and what the tenant, as controller, must decide or sign off. The tenant rates the residual risk for each risk id in section 7; the expected level here is guidance, not the rating. Fields marked *Tenant completes* are the provider's own.

### 7A.1 Lawful bases

Taken from the records of processing ([records-of-processing.md](records-of-processing.md), Part B). Consent is **never** the lawful basis for care records; it covers only optional processing (B8 to B10). A consent record in the care record is the person's decision about their care, not a lawful basis.

| Processing | Article 6 basis | Article 9 condition |
| --- | --- | --- |
| Care records (B1): people lifecycle, care plans, assessments, notes, charts, body map and photos for care, capacity and DoLS records, downtime and transfer packs, break-glass and search | Independent provider: Art 6(1)(b), or 6(1)(f) where the contract is with a funder. Public body: Art 6(1)(c) or 6(1)(e) | Art 9(2)(h) with DPA 2018 s.10(2) and Schedule 1 paragraph 2 (health or social care purposes), by or under the responsibility of staff under a duty of confidentiality (Art 9(3), DPA 2018 s.11) |
| Family members and representatives (B2), and sharing with them under a sharing decision other than consent | Art 6(1)(f), or 6(1)(e) for a public body | As B1 where health information is shared; the conditions for sharing under a legal authority or a best-interests decision are for the DPO to confirm (H-38) |
| Safeguarding (B4) | Art 6(1)(ea) recognised legitimate interest, or 6(1)(c) or (e) for a public body | Art 9(2)(g) with DPA 2018 Schedule 1 paragraph 18, with an appropriate policy document |
| Audit, break-glass and search records (B5) | Art 6(1)(c) or 6(1)(f); 6(1)(c) or (e) for a public body | As B1 where a typed reason mentions health |
| Incidents, statutory notifications, candour and inspector evidence packs (B7) | Art 6(1)(c) legal obligation (for evidence packs, Health and Social Care Act 2008 s.64 where CQC requires the information) | Art 9(2)(h) with Schedule 1 paragraph 2 (for evidence packs paragraph 2(2)(f)), or Art 9(2)(i) with Schedule 1 paragraph 3 for public health |
| Family feed photos and update notifications (B8, optional) | Art 6(1)(a) consent | Art 9(2)(a) explicit consent where a photo or update reveals health |
| Full export | The controller's own copy of its data, not a disclosure; each category keeps its own basis | As the category |
| Sample data | Not personal data: invented people only | None |

### 7A.2 Risks, measures and decisions

| Processing | Risks | Measures built (evidence) | Expected residual | Tenant decides or signs off |
| --- | --- | --- | --- | --- |
| People lifecycle: enquiries, pre-admission, decisions to admit and their conditions, admission, welcome checklist, rooms and beds, property and keys, reviews, hospital transfer packs, discharge, transfer and death | R1, R4, R5, R6, R14 | Workflows with checklists and a second person to confirm residents' money at exit (`packages/domain/src/people/pre-admission.ts`, `admission.ts`, `property.ts`, `reviews.ts`, `transfer-pack.ts`, `exit.ts`; `apps/api/src/routes/people-lifecycle.ts`, `people-exit.ts`, `people-transfers.ts`); the transfer pack is a stored snapshot printed on request, each print audited with the hospital named ([ADR-0040](../decisions/0040-transfer-pack-pdf-writer.md), HZ-023); pre-admission records and the property inventory are not sent to devices (records of processing A2); retention `care_record` ([retention.md](../specs/retention.md)) | Medium: enquiries about people never admitted have no retention period of their own yet | The retention period for people never admitted (H-39); who may print transfer packs and how they travel with the person. *Tenant completes* |
| Care plans and risk assessments | R1, R4 | Drafts, published and superseded versions with every earlier version kept, review dates and change triggers (`packages/domain/src/care/care-plan.ts`, `risk-assessment.ts`, HZ-024); access per permission and scope in the API and in row-level security ([ADR-0071](../decisions/0071-data-scope-is-per-permission.md), `apps/api/test/route-gates.test.ts`, `apps/api/test/scope-per-permission.test.ts`) | Low | Who may publish a plan; how the person and their representatives take part. *Tenant completes* |
| Assessments and validated tools (MUST, Waterlow, Braden, NEWS2, NG249 falls) | R4 | Each tool calculated exactly as published, with its workings shown and table-driven tests (`packages/domain/src/care/must.ts`, `waterlow.ts`, `braden.ts`, `news2.ts`, `falls.ts`, HZ-012); the result links the tenant's own escalation policy (`packages/domain/src/care/escalation-policy.ts`); no other score, diagnosis or recommendation ([medical-device-boundary.md](medical-device-boundary.md)); no decision is taken on a result alone (UK GDPR Art 22) | Low | The escalation policy for each tool and band; the tool licences (H-25). *Tenant completes* |
| Daily notes and charts | R1, R2, R4 | Append-only entries with client ids, so a retry never duplicates; corrections are new entries with a reason; late-entry and clock-drift flags (`packages/domain/src/care/entries.ts`, HZ-017, HZ-029, HZ-010); note text copied into a search column in the same row ([ADR-0070](../decisions/0070-search-on-postgres-full-text.md), H-380) | Low | Recording standards for staff. *Tenant completes* |
| Body map and photos | R1, R6 | The side of a mark worked out by the server from the drawing (`packages/domain/src/care/body-map.ts`, HZ-019); photos stored as documents, checked by content, scanned for malware and stored encrypted (`apps/api/src/routes/documents.ts`, `packages/domain/src/platform/documents.ts`, [ADR-0031](../decisions/0031-document-storage-scanning-and-destruction.md)); care and identification photos never reach the family feed, which takes only `feed_photo` documents (records of processing, family feed row) | Medium: photos of the body are intimate | When staff photograph a wound or skin, on which devices, and how the person is told (the basis is B1, not consent). *Tenant completes* |
| Consent, capacity, best interests and DoLS | R1, R18 | The two-stage capacity test in the Act's words; consent and authority checked against the contact's recorded legal authority; the best-interests checklist; the DoLS register with expiry reminders and the legal-change review; every earlier version kept (`packages/domain/src/care/mca/capacity.ts`, `consent.ts`, `best-interests.ts`, `dols.ts`, `apps/api/src/routes/mca.ts`, HZ-020, HZ-026) | Medium | The Mental Capacity Act policy; who may assess capacity; the DoLS reminder days (H-64). *Tenant completes* |
| Incidents, investigations, statutory notifications and duty of candour | R1, R17 | The classifier's questions decide which notifications apply and their deadlines, with overdue escalation (`packages/domain/src/safety/classifier.ts`, `notifications.ts`, HZ-013, HZ-090, HZ-091); only holders of `safety.notification.submit` submit, after a fresh sign-in (`apps/api/src/routes/statutory-notifications.ts`); the person who raised an incident cannot close it (`packages/domain/src/platform/separation-of-duties.ts`); readers who see only some of the people on an incident see only their own ([ADR-0033](../decisions/0033-incident-scope.md)); candour letters go to the relevant person only (H-103); retention `serious_incident` once a notification applies | Medium: incidents hold third parties' data | Who holds `safety.notification.submit`; the check of each form before it is sent; the candour process. *Tenant completes* |
| Family feed and portal | R6, R11, R16 | Only sections a sharing decision covers, checked on every read (`packages/domain/src/people/sharing.ts`, `packages/domain/src/comms/feed-visibility.ts`, HZ-022); composing refuses other residents' and staff names and holds publishing while an incident about the person is open (`packages/domain/src/comms/feed-compose.ts`, `feed-text.ts`, HZ-061); notifications carry a generic line and a link only ([ADR-0060](../decisions/0060-family-notification-channels.md), HZ-060); the portal reaches only the family member's own rows ([ADR-0061](../decisions/0061-family-portal-scope-and-row-level-security.md)); photos only under consent or a best-interests decision, taken down when it ends (`photoItemsToWithdraw`) | Medium | The sharing policy; the photo consent wording (H-106); the basis for sharing under a legal authority or a best-interests decision (H-38); the feed defaults (H-107); section 10. *Tenant completes* |
| Break-glass (opening a record and searching) | R1, R15 | A typed reason and a reason code; an alert to the Registered Manager and the data protection lead, and an audited record when no one could be told; a daily limit on break-glass searches, which show identity only and exact matches; the weekly report (`apps/api/src/routes/break-glass-search.ts`, `apps/api/src/routes/break-glass-report.ts`, `packages/domain/src/people/break-glass-report.ts`, `apps/api/test/break-glass-search.test.ts`) | Medium: depends on the weekly review | Who reviews the weekly report, and what happens on misuse. *Tenant completes* |
| Search | R15 | `platform.search.use`; each kind of record searched only where the searcher's permissions and scope reach, with MFA for care records; the audit keeps what was shown, never the words typed (`packages/domain/src/platform/search.ts`, `apps/api/src/routes/search.ts`, `apps/api/test/search.test.ts`, HZ-011) | Low | How long search audit events that showed no person are kept (H-121); the search copies in backups (H-380) |
| Full export | R14 | The owner only, after a fresh sign-in with MFA; one download, then the archive is deleted; an expiry; secret and internal columns never leave; sample people left out (`packages/domain/src/platform/export.ts`, `export-catalogue.ts`, `apps/api/src/routes/exports.ts`, [platform-completions.md](../specs/platform-completions.md) rules 10 to 16, HZ-070, HZ-071) | Medium: once downloaded, the copy is the tenant's to protect | Who may ask for an export; where a downloaded export is kept and when it is destroyed; the expiry (H-118). *Tenant completes* |
| Inspector evidence packs and their links | R13 | Minimised by rule: people in scope only, third parties and staff by role, identifiers withheld, free text withheld until redacted by hand; a recipient-bound link with a one-time code sent to the recipient's work email, an expiry and revocation; the bundle deleted when the link ends; watermarked; every open audited (`packages/domain/src/quality/evidence-pack.ts`, `apps/api/src/routes/evidence-packs.ts`, `apps/api/src/routes/evidence-link.ts`, [ADR-0050](../decisions/0050-evidence-pack-links.md), HZ-050); retention `evidence_pack` | Low | The basis, redaction rules and defaults (H-96, H-217, H-218); who may release a pack. *Tenant completes* |
| Downtime packs and outages | R2, R14 | A fresh sign-in and an hourly limit to build or print; the PDF drawn on request and never stored; no photos printed; the kiosk copy encrypted and opened only in a PIN session of a holder of `operations.downtime.read` (`packages/domain/src/operations/downtime-pack.ts`, `kiosk-cache.ts`, `apps/api/src/routes/operations.ts`, [kiosk.md](kiosk.md), HZ-021); retention `downtime_pack` (one month) | Medium: printed copies are outside Harbour | Secure storage and shredding of printed packs in the business continuity plan; the downtime defaults (H-98). *Tenant completes* |
| Sample data | R19 | Invented people only (999-range NHS numbers, `example.invalid` emails), flagged and badged, watermarked on print, left out of exports and notifications, removed as a batch (`packages/domain/src/platform/sample-data.ts`, `apps/api/src/routes/sample-data.ts`, HZ-072) | Low | Remove sample data before go-live; the sample telephone numbers (H-123) |
| Offline devices and held entries | R2, R8 | Device copies encrypted with SQLCipher and wiped at sign-out, remote sign-out or revocation; the offline window set in the signed sync token; entries unsent at sign-out held for their owner only, and deleted only with a coded reason that is audited (`packages/sync/src`, `apps/api/src/routes/sync.ts`, `devices.ts`, `refused-entries.ts`, `packages/domain/src/care/discard-reasons.ts`, [ADR-0011](../decisions/0011-offline-window-and-kiosk-lock.md), [ADR-0029](../decisions/0029-mobile-offline-stack.md), HZ-040, HZ-110, [care.md](../specs/care.md) section 6) | Medium | MDM enrolment and lost-device reporting; the interim device positions (H-68). *Tenant completes* |
| Letters and emails from templates | R16 | Approved templates only, never approved by their author; the recipient is the person or one of their own contacts; NHS number, date of birth and special category fields never in an email; incident and candour letters by letter only (`packages/domain/src/comms/templates.ts`, `apps/api/src/routes/letters.ts`, `letter-templates.ts`, [ADR-0051](../decisions/0051-personal-data-in-template-emails.md), HZ-051) | Low | Approving the templates; keeping contacts' addresses current; the email connection (H-356). *Tenant completes* |

### 7A.3 Tenant's local notes

| Item | Value |
| --- | --- |
| Phase 1 processing the tenant does not use (and why) | *Tenant completes* |
| Local risks added in section 6 | *Tenant completes* |
| Who reviewed section 7A, and when | *Tenant completes* |

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
