# Records of processing (UK GDPR Article 30)

| Item | Value |
| --- | --- |
| Law | [UK GDPR Article 30](https://www.legislation.gov.uk/eur/2016/679/article/30); special category conditions in [Article 9](https://www.legislation.gov.uk/eur/2016/679/article/9) and [DPA 2018 Schedule 1](https://www.legislation.gov.uk/ukpga/2018/12/schedule/1); recognised legitimate interests inserted by the [Data (Use and Access) Act 2025](https://www.legislation.gov.uk/ukpga/2025/18/contents) |
| Part A | Thapsus Cargo Ltd's register **as processor** (Art 30(2)) |
| Part B | Template register for each tenant **as controller** (Art 30(1)), pre-filled in-app |
| Rule | A PR that adds a personal data field or a processing purpose updates this file in the same PR (master prompt 19 definition of done; the CI docs gate enforces it for `data-protection` PRs) |
| Last updated | 11 October 2026, Phase 0 |

## Phase 0 data categories

These are the personal data categories that exist in the Phase 0 schema. The authoritative field list is the Drizzle schema in `packages/db`; this table must match it.

| Category | Data subjects | Example fields | Special category? | Purpose (Part B) |
| --- | --- | --- | --- | --- |
| Tenant | None directly (organisation); named officers | Legal name, CQC provider ID, registered office, named Nominated Individual, DPO, Caldicott Guardian and SIRO contacts | No | B6, B7 |
| Location | None directly; Registered Manager named | Name, address, CQC location ID, ODS code, nation, services | No | B6 |
| Staff user account | Staff, agency workers | Name, work email, phone, role and scopes, photo (for the shared-device picker), authenticators (passkey public keys, encrypted TOTP secret), sessions, devices, IP addresses | No | B3, B5 |
| Person demographics (MODS-aligned) | People receiving care | Names and preferred name, date of birth, NHS number, sex and gender, address, room, location, status, photo for identification | Yes where it reveals health (status, location type) | B1 |
| Contacts | Family, representatives, next of kin, attorneys | Name, relationship, contact details, role (next of kin, LPA, deputy), legal authority reference | No (about the contact) | B2 |
| Allergies | People receiving care | Substance, reaction, severity, status, recorded by and when | Yes (health) | B1 |
| Communication needs | People receiving care | Accessible Information Standard needs, SNOMED-coded, preferred format | Yes (health, disability) | B1 |
| Audit events | Staff (actors); people and contacts referenced by opaque ID | Actor, role, scope, tenant, device, IP, action, record ID, before and after hashes, justification text where captured | Indirectly (a justification may mention health) | B5 |
| Break-glass records | Staff (actors); people by opaque ID | Who opened which record, the typed justification, when it lapses, review outcome | Indirectly (a justification may mention health) | B1, B5 |
| Notifications and deliveries | Staff | Recipient, generic title (no personal data, checked before sending), link, read and acknowledged times; for email deliveries the staff member's work email address and the provider message id | No | B5 |
| Integration inbound data and quarantine | Depends on the partner feed (for example council remittances name people) | The partner's payload as received, validation problems, who resolved it and how | Possibly (partner payloads) | B1, B4 |
| Daily notes, charts and body maps (Phase 1) | People receiving care; staff (authors) | Note text and tags, chart values (fluids, food with IDDSI level, repositioning, bowel, weight, vital signs with the NEWS2 result), body-map marks with photos, event, device and server times, late-entry and clock-drift flags, corrections with reasons; the care profile (IDDSI levels and who advised them, fluid target, SpO2 scale decision and clinician, skin risk) | Yes (health) | B1 |
| Care plans and risk assessments (Phase 1) | People receiving care; staff (authors and publishers); representatives named at sign-off | Needs by the 16 care plan domains, outcomes in the person's words, strengths, contingency plans, actions with the role and schedule; who agreed the plan (the person, a representative's name and authority, or the reason they could not) and when; risk assessments: hazard, who is at risk, template answers, bed rail measurements, likelihood, severity, controls, residual risk, positive-risk statement, the person's views, review dates, closure reason; review reasons; every earlier version | Yes (health) | B1, B2 |
| Validated tool results (Phase 1) | People receiving care; staff (assessors) | MUST, Waterlow and Braden answers (weight, height, BMI, weight loss, appetite, continence, mobility, skin, special risks), the NG249 falls answers, score, band, workings, follow-ups raised, next due date, event, device and server times, corrections with reasons | Yes (health) | B1 |
| Activities and visiting log (Phase 1) | People receiving care; visitors (a recorded contact or a name written in free text, with relationship); staff | Activity, group session, attendance, engagement in words, notes; visit kind (facilitated visit, visit out, accompaniment), visitor, start and end times, restrictions applied and the reason (may mention health or an outbreak), notes | Yes (health, by context) | B1, B2 |
| Advance care records (Phase 1) | People receiving care; clinicians named on the record | Kind (ReSPECT, DNACPR, ADRT, advance care plan), the CPR decision, clinician's name and role, date completed, review date, the scanned form, details as written (for example treatments refused), withdrawal reason, the record each one superseded | Yes (health) | B1 |
| Tasks and workflows (Phase 1) | Staff (assignees, completers); people receiving care by opaque ID | Generic task title, due window, status, who completed it and when, the reason for a skipped or cancelled task (free text, may mention health), workflow states and the reasons given for each step | Indirectly (reasons may mention health) | B1, B5 |
| Documents and photos (Phase 1) | People receiving care; staff; contacts named in letters | Photos for identification, wound and skin photos, letters and legal authority evidence, organisation documents; display file name, content hash, scan result, version, who uploaded it | Yes (health; photos of the body) | B1 |
| Document signatures (Phase 1) | Staff, people receiving care, their representatives | Typed name, capacity (staff, person, representative), statement agreed, hash of the version signed, time | No (about the signer); the document may be | B1, B2 |
| Legal holds and destruction certificates (Phase 1) | People receiving care by opaque ID; tenant decision-makers | Reason for the hold (may mention legal proceedings), who placed and released it; ids, record class and rule of destroyed records | Indirectly | B5 |
| Pre-admission assessments and decisions to admit (Phase 1) | People being assessed, including people never admitted; family members and professionals who gave information | Needs, risks, medicines list, allergies, communication, capacity and legal status, resuscitation decisions, infection status, dependency, funding, information sources, how the person took part, the decision with reasons and conditions, who decided | Yes (health) | B1 |
| Admission, beds and move history (Phase 1) | People receiving care; staff | Placement and trial dates, council or NHS funding flags, room and bed with dates, move reasons, welcome checklist items with who did them and when | Yes where it reveals health (for example a nursing unit) | B1 |
| Personal property inventory and keys (Phase 1) | People receiving care; representatives and personal representatives; staff witnesses | Item descriptions, photos and estimated values, acknowledgement and return signatures (typed names, or why the person could not sign), recipients and their capacity (for example executor), disposal reasons, lost-item incidents, keys issued and returned | Possibly (aids such as hearing aids and dentures reveal health) | B1, B2 |
| Review records and family involvement (Phase 1) | People receiving care; family members and representatives; council reviewers | Review dates, participants, outcomes, changes reviewed, the family involvement record (attended, contributed, declined, the person declined), council review reference | Yes (health) | B1, B2 |
| Hospital transfer packs (Phase 1) | People receiving care; next of kin and representatives named in the pack; staff | A snapshot of identity, photo, allergies, medicines, communication needs, resuscitation decisions, About Me, what is usual for the person, IDDSI levels, capacity and legal status, contacts, infection status, belongings sent and the reason for transfer; who acknowledged missing items and why; disclosed to the receiving hospital | Yes (health) | B1 |
| Discharge, transfer and death records (Phase 1) | People receiving care; next of kin; professionals who verified a death | Exit date, destination or receiving provider, place and time of death, who verified it and their role, who was present, expected or not, coroner referral reference, funeral director, checklist items and the notifications made | Yes (health) | B1, B7 |
| Sharing decisions and About Me share links (Phase 1) | People receiving care; family members, representatives, professionals and link recipients | Recipient, sections and care plan domains shared, basis (consent, legal authority, best interests, direct care), who consented, capacity for the decision, authority type, reference, evidence and end date, valid dates, withdrawal and suspension with reasons; for links a token hash, expiry and last opening | Yes (health; capacity) | B1, B2, B8 |
| Weekly break-glass report (Phase 1) | Staff (actors); people by opaque ID | Counts of openings by user, person and reason code, repeated-use flags, unreviewed openings, who reviewed the report | Indirectly | B5 |
| Consent, capacity and best interests (Phase 1) | People receiving care; representatives (attorneys, deputies, relatives, advocates) named with their authority; people consulted about a best-interests decision; assessors | The decision, given or refused, who gave it and their authority (kind of lasting power of attorney, Office of the Public Guardian reference and registration, the deputy's order scope, decisions, end date and court reference), the capacity status found and its assessment, how the decision was made, restraint conditions, the best-interests decision, expiry, withdrawal and its reason; capacity assessments (the decision and time, the assessor, practicable steps, stage 1 impairment and its description, stage 2 answers with evidence, outcome and reason in the Act's words, review date); best-interests decisions (section 4 checklist answers, consultees' names and views, the IMCA prompt, the decision, review date); every earlier version | Yes (health, mental capacity) | B1, B2 |
| DoLS register and the legal-change review (Phase 1) | People receiving care; the relevant person's representative; supervisory bodies (by name) | Type, request date, outcome and its date, dates in force, urgent extensions, conditions, the representative, supervisory body and reference, objection evidence, withdrawal and end reasons; the review of an authorisation after the June 2026 judgment (the multifactorial assessment, whether and how the person objects, consent signs, decision, who decided, referral to the local authority, closing reason) | Yes (health; deprivation of liberty) | B1, B7 |
| Incidents and investigations (Phase 1) | People receiving care; staff and agency workers (reporters, witnesses, injured workers); visitors and others named on an incident; family members told about it | Type, time, location, device and server times, description and immediate actions (free text that may name third parties), severity and harm grade as staff judged them, emergency services and GP contact, who in the family was told and when, the people on it with their role and injuries, a death, learning disability and autism (for LeDeR) and Mental Health Act status, linked body-map marks, infection case details (onset, flu confirmation, linkage), the classifier's answers, result and reasoning; investigation lead, method, findings, contributing factors, actions with owners and lessons | Yes (health; third-party data about witnesses, staff and visitors) | B1, B3 (staff injuries), B4 (safeguarding), B7 |
| Statutory notifications and duty of candour (Phase 1) | People receiving care; the relevant person for candour and anyone acting for them; staff (who prepared and submitted); regulators by reference | Kind, due time and deadlines, provisional flag, reasons, the prepared content of the regulator's form, submission time, external reference and evidence document, reasons a notification was not required, the regulation 18(4B) DoLS statement; the candour threshold decision and the health care professional named, the verbal and written notifications, contact attempts, enquiry results shared and correspondence documents | Yes (health) | B7 (B4 for safeguarding concerns) |
| Support access requests | Thapsus support staff; tenant owners | Ticket reference, reason, requesting operator, deciding owner, decision and expiry | No | B5 |
| Thapsus operator register (Thapsus as controller, not processor) | Thapsus staff | Name, role, sign-in identity | No | Thapsus's own register |

MODS: [Minimum Operational Data Standard](https://standards.nhs.uk/published-standards/adult-social-care-digital-social-care-record-minimum-operational-data-standard-mods).

---

## Part A: Thapsus Cargo Ltd as processor (Art 30(2))

### A1. Processor details (Art 30(2)(a))

| Field | Value |
| --- | --- |
| Processor | Thapsus Cargo Ltd (trading as Thapsus) |
| Registered office | `[address - human action]` |
| Company number | `[number - human action]` |
| ICO registration number | `[number - human action]` |
| Data protection officer or named lead | `[DPO or named lead, contact - human action]` (master prompt default: Brian as named lead) |
| UK representative | Not applicable (UK established) |
| Controllers on whose behalf Thapsus acts | Every tenant, listed with controller name, contact and DPO in the operator console tenant register (one row per tenant), exportable for this record |

### A2. Categories of processing carried out for each controller (Art 30(2)(b))

| Processing | Data categories | Where |
| --- | --- | --- |
| Hosting and storage of the tenant's records | All categories above | AWS eu-west-2 (RDS, S3) |
| Synchronisation to the tenant's devices for offline use | Staff account; for people assigned to the user (or receiving care at a manager's or nurse's locations: only people active, on leave or in hospital, so enquiries and people discharged, deceased or archived leave managers' devices): identity, allergies, communication needs, the care profile (IDDSI levels, fluid target, SpO2 scale decision, skin risk), the active care plan, active risk assessments, validated-tool results (summary only), active advance care records, kept while the person is in scope; notes, charts, body-map marks, activities and visits for the last `mobile.offline_window_days` days, a window the API sets in the signed sync token so a device cannot widen it; entries the server refused, with their content, kept on the device until someone removes them with a recorded reason; when a session ends with entries unsent, those entries only, with the owner's staff ids and name, until the owner sends them or the owner or a manager deletes them (the hold escalates to a manager at `mobile.held_entries_max_days`; nothing is deleted automatically); tombstones of deleted unsent entries (a coded reason and opaque ids only: kind, owner, who deleted, entry and person ids, count and time) in the device keystore until the API has recorded them as audit events, the person's own words going only to the API; a device report of unsent, refused and held counts and the oldest age, with no personal data | PowerSync self-hosted in AWS eu-west-2; device store encrypted with SQLCipher (AES-256), wiped on sign-out or remote sign-out; when the session ends with entries unsent, everything else synced is cleared and only those entries stay, encrypted, for their owner to sign in and send, or until the owner or a manager signs in on the device and deletes them with a coded reason and device authentication, recorded at the API (interim position, human actions H-68 and H-85; [care.md](../specs/care.md) section 6) |
| Backup and restore | All | AWS eu-west-2 (RDS snapshots and point-in-time recovery, 35 days) |
| Delivery of email, push and SMS notifications | Staff contact details; notification content without personal data in push | SES London; Expo push via APNs and FCM; UK SMS gateway (TBC) |
| Support, including impersonation with the tenant's approval ticket | Records the support case requires | Operator console; every action audited and visible to the tenant |
| Error monitoring and observability | Opaque IDs, scrubbed error data, no personal data by design | Sentry EU region; Grafana Cloud UK region |
| Data export, DSAR bundles, retention and destruction | All | AWS eu-west-2 |
| Optional AI processing (only if the tenant enables it) | Pseudonymised records; free text only with consent | Per [sub-processors.md](sub-processors.md) |

### A3. Transfers outside the UK (Art 30(2)(c))

Core hosting stays in the UK. Services outside the UK, with geography and safeguard, are listed in [sub-processors.md](sub-processors.md): Sentry (EU region), Expo push (device tokens; notification content free of personal data), and optional AI providers. `[Transfer mechanism for each to be confirmed - DPO human action]`

### A4. Security measures (Art 30(2)(d))

Summarised in the DPA template Schedule 2 and detailed in [security-checklist.md](security-checklist.md): UK hosting, encryption at rest (AES-256) and in transit (TLS 1.2+), Postgres row-level security with `FORCE` per tenant, MFA, least privilege, append-only audit, backups with point-in-time recovery, vulnerability management, no personal data in logs.

### A5. Thapsus as controller

Thapsus's own processing as controller (tenant contact and billing data, operator staff accounts, Thapsus employees, marketing to prospective customers, security logs of the operator console) is recorded in a separate register held by the Thapsus DPO lead `[human action]`.

---

## Part B: template register for each tenant as controller (Art 30(1))

Harbour pre-fills this register in-app from the tenant's configuration (modules enabled, service types, sector). The tenant's DPO or named lead reviews it and keeps it current. Fields in *italics* are pre-filled.

### B0. Controller details (Art 30(1)(a))

| Field | Value |
| --- | --- |
| Controller | *Tenant legal name* |
| Contact | *Registered office, email* |
| DPO or data protection lead | *From tenant governance settings* |
| Caldicott Guardian, SIRO | *From tenant governance settings* |
| Joint controllers | None by default; record any (for example a council under a shared-care arrangement) |
| Sector | *Independent provider* or *public body* (this selects the lawful basis column below) |

### B1 to B10. Processing purposes

Lawful basis follows master prompt section 5.1 exactly. Consent is **never** the basis for care records; it governs only optional processing (B8 to B10).

| ID | Purpose (Art 30(1)(b)) | Data subjects and data (Art 30(1)(c)) | Art 6 basis: independent provider | Art 6 basis: public body | Special category condition | Recipients (Art 30(1)(d)) | Retention (Art 30(1)(f)) | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | Delivering and recording health and social care: person demographics, photo for identification, allergies, communication needs, and later care plans, notes, charts and medicines | People receiving care; Phase 0 categories: person demographics, allergies, communication needs | Art 6(1)(b) contract, or 6(1)(f) legitimate interests where the contract is with a funder | Art 6(1)(c) legal obligation or 6(1)(e) public task | Art 9(2)(h) with DPA 2018 s.10(2) and Sch 1 para 2 (health or social care purposes), processed by or under the responsibility of staff under a duty of confidentiality (Art 9(3), DPA 2018 s.11) | Staff within scope; external professionals with scoped, time-limited access (Caldicott principle 7); Thapsus as processor; regulators on request | Care records: 8 years after care ends by default ([../specs/retention.md](../specs/retention.md)) | 0 onward |
| B2 | Recording and contacting family members and representatives in connection with care | Contacts: names, relationship, contact details, legal authority | Art 6(1)(f) legitimate interests | Art 6(1)(e) public task | None normally | Staff within scope; Thapsus as processor | With the person's record | 0 onward |
| B3 | Employment and workforce management: staff user accounts, roles, access, and later recruitment, training and rota records | Staff and agency workers: account data, photo, authenticators, devices | Art 6(1)(b) contract of employment; 6(1)(c) where a law requires the record | Same | Where special category data is processed (for example health in later phases): Art 9(2)(b) with DPA 2018 Sch 1 para 1 (employment), with an appropriate policy document. Criminal offence data (DBS, Phase 2): Art 10 with Sch 1 para 1 | Managers, HR; Thapsus as processor | Staff files: 6 years after leaving or to 75th birthday as the tenant selects ([../specs/retention.md](../specs/retention.md)) | 0 onward |
| B4 | Safeguarding adults at risk: concerns, referrals, enquiries | People receiving care, alleged perpetrators, witnesses, staff | Art 6(1)(ea) recognised legitimate interest (safeguarding a vulnerable individual) | Art 6(1)(c) or 6(1)(e) | Art 9(2)(g) with DPA 2018 Sch 1 para 18 (safeguarding of children and of individuals at risk), with an appropriate policy document | Local authority safeguarding team, police, CQC; Thapsus as processor | Per [../specs/retention.md](../specs/retention.md) | 1 or 2 |
| B5 | Security, audit and accountability: audit trail, security logs, device and session management | Staff (actors), people and contacts by opaque ID | Art 6(1)(c) legal obligation (UK GDPR Arts 5(2) and 32; Regulation 17 record-keeping) or 6(1)(f) | Art 6(1)(c) or 6(1)(e) | Where an audit justification contains health data, as B1 | Tenant DPO and managers; Thapsus as processor | Security logs at least 6 months; audit of a care record kept as long as the record | 0 onward |
| B6 | Running the service: tenant and location administration, CQC registration details | Named officers (Nominated Individual, Registered Manager) | Art 6(1)(b) or 6(1)(f) | Art 6(1)(e) | None | Thapsus as processor; CQC | While the tenant is a customer, then per contract | 0 onward |
| B7 | Statutory notifications and regulatory returns (CQC, RIDDOR, UKHSA, Capacity Tracker) | People receiving care, staff | Art 6(1)(c) legal obligation | Art 6(1)(c) | Art 9(2)(h) with Sch 1 para 2, or Art 9(2)(i) with Sch 1 para 3 (public health) as applicable | CQC, HSE, UKHSA, local authority | Per [../specs/retention.md](../specs/retention.md) | 1 onward |
| B8 | Optional: photos and updates shared in the family portal | People receiving care, family members | Art 6(1)(a) consent | Art 6(1)(a) consent | Art 9(2)(a) explicit consent where the photo or update reveals health | Named family members | Until consent is withdrawn or the record's retention ends | 4 |
| B9 | Optional: marketing to families and enquirers | Contacts, enquirers | Art 6(1)(a) consent (and PECR) | Same | None | Tenant | Until consent is withdrawn | When built |
| B10 | Optional: AI processing of free-text notes (AI module off by default) | People receiving care (pseudonymised), staff | Art 6(1)(a) consent for free text; other AI features use the basis of the underlying purpose | Same | Art 9(2)(a) explicit consent for free text. Where the person lacks capacity to consent, their free text is excluded unless someone with legal authority consents `[DPO to confirm - human action]` | AI provider chosen by the tenant ([sub-processors.md](sub-processors.md)) | Prompt and response audit 12 months (pseudonymised) | 6 |

Notes:

- The photo in the point-of-care header (B1) is a safety control against wrong-person selection (hazard HZ-001), not an optional feature, so it is not consent-based. Photos shared with families (B8) are.
- The national data opt-out is flagged per person and honoured for any use beyond direct care (for example reporting to the NHS).
- The hospital transfer pack and the transfer of care summary are disclosures for direct care under B1 to the receiving hospital or provider, audited with the recipient. Death notifications to the regulator, the medical examiner and LeDeR are B7.
- Family members, representatives and professionals see a section of a person's record only under a recorded sharing decision ([people.md](../specs/people.md) rule 13): photos and updates under consent (B8); care plan sections, health summaries and finance under the person's consent, a legal authority (lasting power of attorney, deputyship, appointeeship), a best-interests decision or direct care. Which Article 6 and Article 9 conditions apply to sharing under a legal authority or best-interests decision is for the DPO to confirm `[DPO - human action]` (H-38).
- Consent records (B1) record the person's decisions about their care and who made them; they are not consent as a lawful basis, which stays limited to B8 to B10 (master prompt 5.1).
- Incidents may hold third-party data about witnesses, staff and visitors. A staff injury is also B3, and RIDDOR reports are B7. Disclosure to CQC, HSE, local authorities, the police, UKHSA, LeDeR and the medical examiner is a legal obligation (Article 6(1)(c), or the B4 and B7 conditions) recorded on the notification with its reference ([safety.md](../specs/safety.md) section 8). A reader who can see only some of the people on an incident sees the header and their own people ([ADR-0033](../decisions/0033-incident-scope.md), H-70).
- Pre-admission assessments of people who are never admitted have no retention period of their own yet; until one is set (H-39) they follow `care_record`, counted from the date the enquiry closed.

### B11. Transfers (Art 30(1)(e))

*Pre-filled from the sub-processor register for the modules and providers the tenant has enabled.*

### B12. Security measures (Art 30(1)(g))

*Pre-filled: reference to Thapsus's measures (Part A4) plus the tenant's own organisational measures (training, device policy, access reviews), which the tenant completes.*
