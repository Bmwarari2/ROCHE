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
| Tasks and workflows (Phase 1) | Staff (assignees, completers); people receiving care by opaque ID | Generic task title, due window, status, who completed it and when, the reason for a skipped or cancelled task (free text, may mention health), workflow states and the reasons given for each step | Indirectly (reasons may mention health) | B1, B5 |
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
| Synchronisation to the tenant's devices for offline use | Assigned people's records and reference data; staff account | PowerSync self-hosted in AWS eu-west-2; encrypted device store |
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

### B11. Transfers (Art 30(1)(e))

*Pre-filled from the sub-processor register for the modules and providers the tenant has enabled.*

### B12. Security measures (Art 30(1)(g))

*Pre-filled: reference to Thapsus's measures (Part A4) plus the tenant's own organisational measures (training, device policy, access reviews), which the tenant completes.*
