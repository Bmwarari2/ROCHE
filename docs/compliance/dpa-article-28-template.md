# Data processing agreement (UK GDPR Article 28): template

> **Template status**: drafted from UK GDPR Article 28 and the [ICO guidance on what a controller-processor contract must include](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/contracts-and-liabilities-between-controllers-and-processors-multi/what-needs-to-be-included-in-the-contract/). It must be reviewed by a solicitor before use `[human action]`. Square-bracketed values are proposed defaults for Brian to confirm `[human action]`. Each tenant signs it in-app before go-live.

**This agreement** is between:

- **the Controller**: `{{tenant.legalName}}`, `{{tenant.registeredOffice}}`, company or charity number `{{tenant.companyNumber}}`; and
- **the Processor**: Thapsus Cargo Ltd (trading as Thapsus), `[registered office - human action]`, company number `[number - human action]`.

It forms part of the Harbour subscription agreement (the **Main Agreement**). If they conflict on data protection, this agreement prevails.

## 1. Definitions

"Data Protection Legislation" means the UK GDPR, the Data Protection Act 2018 (both as amended, including by the Data (Use and Access) Act 2025) and the Privacy and Electronic Communications Regulations 2003. "Personal Data", "Processing", "Data Subject", "Personal Data Breach" and "Supervisory Authority" have the meanings in the UK GDPR. "Services" means the Harbour platform and support provided under the Main Agreement. "Sub-processor" means a third party engaged by the Processor to process Personal Data on the Controller's behalf.

## 2. Subject matter, duration, nature and purpose (Art 28(3), first paragraph)

The subject matter, duration, nature and purpose of the processing, the types of Personal Data and the categories of Data Subjects are set out in **Schedule 1**.

## 3. Documented instructions (Art 28(3)(a))

3.1 The Processor processes Personal Data only on the Controller's documented instructions, including with regard to transfers to a third country or international organisation, unless UK law requires otherwise; in that case it tells the Controller of the legal requirement before processing, unless that law prohibits this on important grounds of public interest.

3.2 The Controller's instructions are this agreement, the Main Agreement, and the Controller's configuration and use of the Services (including enabling modules, AI features and integrations).

3.3 The Processor immediately informs the Controller if, in its opinion, an instruction infringes Data Protection Legislation (Art 28(3), final paragraph).

## 4. Confidentiality (Art 28(3)(b))

The Processor ensures that everyone it authorises to process Personal Data has committed to confidentiality or is under an appropriate statutory obligation of confidentiality. Support access to the Controller's records is by impersonation only with the Controller's approval ticket, and every action is audited and visible to the Controller.

## 5. Security (Art 28(3)(c) and Art 32)

The Processor implements the technical and organisational measures in **Schedule 2** and keeps them under review. It will not reduce the overall level of protection during the term.

## 6. Sub-processors (Art 28(2), 28(3)(d), 28(4))

6.1 The Controller gives general written authorisation for the Processor to engage the Sub-processors listed in the sub-processor register shown in Harbour (**Schedule 3**).

6.2 The Processor notifies the Controller in-app and by email at least `[30]` days before adding or replacing a Sub-processor. The Controller may object on reasonable data protection grounds within that period; the parties will discuss the objection in good faith, and if it cannot be resolved the Controller may terminate the affected Services without penalty.

6.3 The Processor imposes on each Sub-processor, by contract, data protection obligations that are the same in substance as those in this agreement, in particular sufficient guarantees of appropriate technical and organisational measures.

6.4 The Processor remains fully liable to the Controller for the performance of each Sub-processor's obligations.

## 7. Data subject rights (Art 28(3)(e))

7.1 Taking into account the nature of the processing, the Processor assists the Controller by appropriate technical and organisational measures, insofar as possible, to respond to requests to exercise data subject rights. In Harbour this includes the DSAR workbench, rectification by correction events, erasure where retention law allows, restriction flags, and person-level and full-tenant export.

7.2 If the Processor receives a request directly from a Data Subject about the Controller's data, it passes it to the Controller within `[2]` working days and does not respond substantively unless instructed ([dsar-procedure.md](dsar-procedure.md)).

## 8. Assistance with security, breaches, DPIAs and prior consultation (Art 28(3)(f), Arts 32 to 36)

8.1 The Processor assists the Controller in meeting its obligations under Articles 32 to 36, taking into account the nature of the processing and the information available to it.

8.2 **Breaches**: the Processor notifies the Controller without undue delay, and in any event within `[24]` hours, after becoming aware of a Personal Data Breach affecting the Controller's data (Art 33(2)). Notification is made in-app to the Controller's DPO and Owner roles and by email, with the information in Art 33(3) as it becomes available, and updates as the investigation proceeds ([breach-response.md](breach-response.md)).

8.3 **DPIAs**: the Processor provides the pre-filled DPIA template and the information the Controller reasonably needs to complete and review its DPIA and any prior consultation with the ICO.

## 9. Deletion or return at the end of the Services (Art 28(3)(g))

9.1 At any time, and at the end of the Services, the Controller may export all its data free of charge in the documented CSV and JSON schema, with documents.

9.2 Within `[30]` days after the end of the Services, the Processor deletes the Controller's Personal Data from live systems, unless UK law requires storage. Copies in backups expire within the backup retention period (35 days) and are rendered unreadable earlier by destruction of the Controller's encryption keys. The Processor issues a destruction certificate ([retention-and-deletion.md](retention-and-deletion.md)).

## 10. Information and audits (Art 28(3)(h))

10.1 The Processor makes available to the Controller all information necessary to demonstrate compliance with Article 28, and allows for and contributes to audits, including inspections, by the Controller or an auditor it mandates.

10.2 The Processor may meet audit requests first by supplying current certifications and reports (for example Cyber Essentials Plus, ISO 27001, the summary of the latest external penetration test, and the control mapping in Harbour's compliance documentation). On-site or remote audits are on `[30]` days' notice, no more than once a year unless following a breach or a Supervisory Authority request, and subject to confidentiality.

## 11. International transfers

The Processor does not transfer Personal Data outside the UK except to the Sub-processors and geographies stated in Schedule 3, with the safeguard stated there (UK adequacy regulations, the International Data Transfer Agreement or the UK Addendum to the EU standard contractual clauses). Optional features that involve a transfer (for example an AI provider outside the UK) are used only if the Controller enables them.

## 12. Processor acting outside instructions (Art 28(10))

If the Processor determines the purposes and means of processing in breach of this agreement, it is treated as a controller for that processing.

## 13. Liability

`[Liability caps and indemnities to be agreed in the Main Agreement - human action]`. Nothing limits either party's liability to Data Subjects under Article 82.

## 14. Term, termination and governing law

This agreement lasts as long as the Processor processes Personal Data for the Controller. Clauses 9 and 10 survive termination. It is governed by the law of England and Wales and the courts of England and Wales have exclusive jurisdiction.

---

## Schedule 1: details of processing

| Item | Details |
| --- | --- |
| Subject matter | Provision of the Harbour care management platform to the Controller |
| Duration | The term of the Main Agreement plus the deletion period in clause 9 |
| Nature | Collection (through the Controller's users), storage, synchronisation to devices, retrieval, display, transmission, export, backup, deletion |
| Purpose | Enabling the Controller to deliver and record care and run its service, as set out in the Controller's records of processing ([records-of-processing.md](records-of-processing.md), Part B) |
| Types of Personal Data | Person demographics (including NHS number and photo), contacts, allergies, communication needs, care and medicines records (as modules are enabled), staff account and employment data, audit data. Special category data: health, and other categories the Controller records. Criminal offence data: DBS results where the workforce module is used |
| Categories of Data Subjects | People receiving care; their family members, representatives and contacts; the Controller's staff and agency workers; external professionals; visitors and enquirers where those modules are used |

## Schedule 2: technical and organisational measures

| Area | Measure |
| --- | --- |
| Location | Production personal data hosted in AWS eu-west-2 (London) |
| Encryption | AES-256 at rest (database, files, backups, mobile store); TLS 1.2 or higher in transit; keys in AWS KMS, rotated yearly |
| Tenant isolation | `tenant_id` on every row; Postgres row-level security with `FORCE ROW LEVEL SECURITY`; non-owner application role; isolation tests in CI |
| Access control | MFA (passkeys, TOTP) for every role that can read care records; role- and attribute-based access; step-up for sensitive actions; break-glass with justification and alerts |
| Audit | Append-only audit of every create, update, delete, view of a care record, export, login, permission change and sync event; pgAudit |
| Resilience | Multi-AZ database; daily snapshots and point-in-time recovery retained 35 days; RPO 15 minutes, RTO 4 hours; quarterly restore drill |
| Vulnerability management | Critical and high findings fixed within 14 days; CodeQL, gitleaks, Trivy, SBOM in CI; annual external penetration test |
| Logging | Security logs kept at least 6 months, UTC, tamper-evident, without personal data |
| Mobile | Encrypted local store, auto-lock, remote wipe, root and jailbreak detection |
| People | Confidentiality commitments; security training; least-privilege operator access with tenant approval |
| Full mapping | [security-checklist.md](security-checklist.md) |

## Schedule 3: authorised sub-processors

As listed in [sub-processors.md](sub-processors.md) and shown in Harbour at the date of signature: `{{subProcessors.inUse[]}}`.

## Schedule 4: contacts

| Role | Controller | Processor |
| --- | --- | --- |
| Data protection contact | `{{tenant.dpo.name}}`, `{{tenant.dpo.email}}` | `[Thapsus DPO or named lead - human action]` |
| Breach notification contact | `{{tenant.breachContact.email}}` | `[security contact - human action]` |

## Signatures

| | Controller | Processor |
| --- | --- | --- |
| Name | | |
| Role | | |
| Date | | |
| Signature (in-app, typed name with audit) | | |
