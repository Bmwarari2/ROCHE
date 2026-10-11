# UK GDPR and DPA 2018 checklist

| Item | Value |
| --- | --- |
| Law | UK GDPR and the Data Protection Act 2018, as amended by the [Data (Use and Access) Act 2025](https://www.legislation.gov.uk/ukpga/2025/18/contents) (commencement: [SI 2026/82](https://legislation.gov.uk/uksi/2026/82)) |
| Roles | Each tenant (care provider) is the **controller**. Thapsus Cargo Ltd is the **processor** for tenant data, and a controller only for its own business data (customer contacts, billing, its own staff) |
| Owner | `[Thapsus DPO or named lead - human action]` (master prompt default: Brian as named lead) |
| Status | Phase 0. "Phase" says when each control lands; "Phase 0" means part of the Phase 0 foundations release, confirmed at the Phase 0 gate |

Legal text: UK GDPR articles are on legislation.gov.uk (for example [Article 9](https://www.legislation.gov.uk/eur/2016/679/article/9)); [DPA 2018 Schedule 1](https://www.legislation.gov.uk/ukpga/2018/12/schedule/1).

## 1. Principles and lawful basis

| Requirement | Source | How Harbour meets it | Phase |
| --- | --- | --- | --- |
| Lawfulness, fairness, transparency | Art 5(1)(a), 6, 9 | Lawful basis recorded per purpose in [records-of-processing.md](records-of-processing.md): care delivery Art 6(1)(b)/(f) (independent) or 6(1)(c)/(e) (public) with Art 9(2)(h) and DPA 2018 Sch 1 para 2; employment Sch 1 para 1; safeguarding Sch 1 para 18 and the recognised legitimate interest for safeguarding a vulnerable individual. Consent is never the basis for care records | Phase 0 (register); in-app display Phase 1 |
| Recognised legitimate interests | Art 6(1)(ea) and Annex 1, inserted by DUAA 2025 | Used for safeguarding by independent providers; recorded per tenant in the register | Phase 1 |
| Appropriate policy document where Sch 1 requires it | DPA 2018 Sch 1 Part 4 | Template appropriate policy document for Sch 1 para 1 and para 18 processing supplied with the DPIA pack `[DPO review - human action]` | Phase 1 |
| Purpose limitation | Art 5(1)(b) | Modules process data only for their stated purpose; secondary uses (reporting to NHS, AI) are separate purposes with their own basis and flags | Phase 0 (design rule) |
| Data minimisation | Art 5(1)(c) | Fields justified per spec; mobile devices sync only assigned people and the next 7 days; AI pseudonymises before sending | Phase 0 (sync scope); AI Phase 6 |
| Accuracy | Art 5(1)(d) | Immutable events with referenced corrections; optimistic versioning for mutable records; review tasks for stale writes | Phase 0 (data model); Phase 1 |
| Storage limitation | Art 5(1)(e) | Retention engine and schedule ([retention-and-deletion.md](retention-and-deletion.md), [../specs/retention.md](../specs/retention.md)) | Per feature register |
| Integrity and confidentiality | Art 5(1)(f), 32 | [security-checklist.md](security-checklist.md) | Phase 0 and ongoing |
| Accountability | Art 5(2), 24 | Append-only `audit_event`; registers; DPIA; this checklist | Phase 0 |
| Consent where used (optional features only) | Art 7, 9(2)(a) | Per-decision consent record (who, capacity, evidence, expiry, withdrawal) for family-portal photos, marketing and AI processing of free text; withdrawal as easy as giving | Phase 1 (consent record); features in later phases |
| Electronic marketing | PECR | Marketing messages only with consent; separate from service messages | When marketing is built |
| Children's data | Art 8 and children's homes standards | Assessed with the children's homes module | Phase 7 |

## 2. Transparency and data subject rights

| Requirement | Source | How Harbour meets it | Phase |
| --- | --- | --- | --- |
| Privacy information | Art 12 to 14 | Privacy notice templates for people receiving care (including easy read), families and staff, editable by the tenant and shown in-app and in portals | Phase 1 |
| Right of access | Art 15; DUAA 2025 (reasonable and proportionate searches; when the clock starts and stops) | DSAR workbench: collects every record about a person across modules, redacts third parties, tracks the one-month clock (extendable by two months), pauses while awaiting ID or clarification, exports a bundle. Procedure: [dsar-procedure.md](dsar-procedure.md) | Per feature register |
| Rectification | Art 16 | Corrections are new events referencing the original, shown as strike-through with author and time | Phase 1 |
| Erasure | Art 17 | Available where retention law allows; refused with reasons where a statutory or Code retention period applies | With retention engine |
| Restriction | Art 18 | Record-level restriction flag that blocks non-essential processing and sharing | Phase 2 |
| Portability | Art 20 | Person-level export in CSV and JSON; full tenant export free at any time in a documented schema | Phase 1 |
| Objection | Art 21 | Applies where the basis is 6(1)(e) or (f); objection logged and routed to the tenant's DPO | Phase 2 |
| Automated decision-making | Arts 22A to 22D, inserted by DUAA 2025 | Harbour makes no solely automated significant decisions. AI is advisory and changes no state without a human ([medical-device-boundary.md](medical-device-boundary.md)) | Phase 0 (design rule); tested Phase 6 |
| Complaints to the controller | DPA 2018 as amended by DUAA 2025 (in force 19 June 2026) | In-product complaint form, 30-day acknowledgement, outcome tracking ([data-protection-complaints.md](data-protection-complaints.md)) | Per feature register |
| National data opt-out | NHS national data opt-out policy | Flag per person; honoured where publicly funded care data is used beyond direct care | Phase 5 or 6 (when NHS reporting is built) |
| Caldicott principle 7 (duty to share for direct care) | [Caldicott Principles](https://www.gov.uk/government/publications/the-caldicott-principles) | External professional access model: named, scoped, time-limited | Phase 4 |

## 3. Accountability and governance

| Requirement | Source | How Harbour meets it | Phase |
| --- | --- | --- | --- |
| Data protection by design and by default | Art 25 | Optional modules and AI off by default; least-privilege roles; scoped sync; no personal data in logs | Phase 0 |
| Processor contract | Art 28 | [dpa-article-28-template.md](dpa-article-28-template.md) `[legal review and signature - human action]` | Template built |
| Sub-processors | Art 28(2), (4) | [sub-processors.md](sub-processors.md), shown in-app; 30 days' notice of changes | Register built; in-app Phase 1 |
| Records of processing | Art 30 | [records-of-processing.md](records-of-processing.md) | Phase 0 |
| Security of processing | Art 32 | [security-checklist.md](security-checklist.md) | Ongoing |
| Breach notification | Art 33, 34 | Breach register with 72-hour clock; processor-to-controller notification automatic in-app ([breach-response.md](breach-response.md)) | Procedure built; register per feature register |
| DPIA | Art 35, 36; [ICO: when is a DPIA needed](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/) | Template pre-filled from tenant configuration, signed in-app by the tenant's DPO before go-live ([dpia-template.md](dpia-template.md)) | Template built; in-app Phase 1 |
| DPO, Caldicott Guardian and SIRO recorded per tenant | Art 37 to 39; master prompt 5.1 | Tenant governance settings | Phase 1 |
| Thapsus DPO | Art 37(1)(c) | Thapsus to assess whether large-scale processing of special category data as a core activity requires a designated DPO `[human action]` | Before first tenant |
| ICO registration (data protection fee) | DPA 2018 and fee regulations | Thapsus registers `[human action, Phase 0]`; tenants confirm their own registration at onboarding | Phase 0 |
| International transfers | Art 44 to 49 | Production personal data stays in AWS London. Any service outside the UK is in the sub-processor register with geography and transfer mechanism stated; model inference outside the UK is disclosed in the register and the DPIA | Phase 0 (register) |
| Off-shoring and public cloud for health and care data | [NHS and social care data: off-shoring and public cloud](https://digital.nhs.uk/data-and-information/looking-after-information/data-security-and-information-governance/nhs-and-social-care-data-off-shoring-and-the-use-of-public-cloud-services) | UK region hosting; evidence pack for tenants' DSPT | Phase 0 (ADR-0001) |
| Data Security and Protection Toolkit | [DSPT standard](https://adultsocialcare.standards.nhs.uk/published-standards/data-security-and-protection-toolkit) | Supplier evidence pack for tenants' DSPT; Thapsus's own DSPT as an IT supplier `[human action]` | Phase 2 |
| Records management | [NHS Records Management Code](https://transform.england.nhs.uk/information-governance/guidance/records-management-code/records-management-code-of-practice/) | Retention defaults in [../specs/retention.md](../specs/retention.md) | With retention engine |
| No personal data in logs, fixtures, screenshots or commits | Master prompt 5.3, 20 | Structured logs carry opaque IDs only; Sentry scrubbing; invented demo people; gitleaks | Phase 0 |
| App store privacy declarations | Apple privacy details, Google Play Data safety | Drafted with the store listing; consistent with this register | Phase 1 |

## 4. Human actions

| Action | Owner |
| --- | --- |
| Appoint the Thapsus DPO or confirm the named lead; assess the Art 37(1)(c) requirement | Brian |
| Register Thapsus with the ICO and pay the data protection fee | Brian |
| Legal review of the DPA template, privacy notice templates and appropriate policy document template | Brian (solicitor) |
| Confirm transfer mechanisms for sub-processors outside the UK | DPO |
| Complete DSPT for Thapsus as an IT supplier | Brian |
