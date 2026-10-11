# Compliance

Master prompt section 5 makes data protection, clinical safety, security, accessibility and audit acceptance criteria for every phase, "not a later hardening pass", each with a checklist here that CI links to. This folder holds those checklists, the registers and templates tenants rely on, and the procedures Thapsus follows as processor.

## Index

| Document | What it is | Main source |
| --- | --- | --- |
| [medical-device-boundary.md](medical-device-boundary.md) | What Harbour does and must never do to stay outside the medical-device definition; the question every clinical PR answers | MHRA software as a medical device guidance |
| [gdpr-checklist.md](gdpr-checklist.md) | UK GDPR and DPA 2018 (as amended by the Data (Use and Access) Act 2025) requirements and how Harbour meets them | UK GDPR, DPA 2018, DUAA 2025 |
| [security-checklist.md](security-checklist.md) | OWASP ASVS 5.0 Level 2 chapter by chapter, OWASP MASVS L2 for mobile, NCSC MFA, password and logging guidance | OWASP, NCSC |
| [accessibility-checklist.md](accessibility-checklist.md) | WCAG 2.2 AA criteria relevant to Harbour and how each is verified | W3C WCAG 2.2 |
| [kiosk.md](kiosk.md) | Shared and kiosk device sign-in, auto-lock, compensating controls and residual risks | Master prompt 5.3, 17.2 |
| [records-of-processing.md](records-of-processing.md) | Article 30 register: Thapsus as processor, and the template for tenants as controllers | UK GDPR Art 30 |
| [dpia-template.md](dpia-template.md) | DPIA template pre-filled from tenant configuration, with the AI addendum | UK GDPR Art 35 |
| [dpa-article-28-template.md](dpa-article-28-template.md) | Data processing agreement template with every Article 28(3) clause | UK GDPR Art 28 |
| [sub-processors.md](sub-processors.md) | Sub-processor register shown to tenants in-app | UK GDPR Art 28(2), (4) |
| [retention-and-deletion.md](retention-and-deletion.md) | How soft delete, legal hold, cryptographic shredding and destruction certificates work | UK GDPR Art 5(1)(e), 17 |
| [dsar-procedure.md](dsar-procedure.md) | Subject access requests: processor and controller steps | UK GDPR Art 12, 15 |
| [breach-response.md](breach-response.md) | Personal data breach response: 72-hour ICO clock, processor-to-controller notification | UK GDPR Art 33, 34 |
| [data-protection-complaints.md](data-protection-complaints.md) | Data protection complaints duty (live 19 June 2026) | DPA 2018 as amended by DUAA 2025 |

Related documents elsewhere: the retention schedule [../specs/retention.md](../specs/retention.md), statutory figures [../specs/rates.md](../specs/rates.md), tenancy and RLS [../decisions/0002-tenancy-and-row-level-security.md](../decisions/0002-tenancy-and-row-level-security.md), clinical safety [../clinical-safety/clinical-risk-management-plan.md](../clinical-safety/clinical-risk-management-plan.md), outstanding human actions [../plans/human-actions.md](../plans/human-actions.md).

## How CI links to these checklists

| Mechanism | What it does |
| --- | --- |
| PR template | Every PR answers "Clinical-safety impact (none / hazard IDs touched)" and "Data-protection impact"; the clinical section repeats the question in [medical-device-boundary.md](medical-device-boundary.md#7-the-question-every-clinical-pr-answers) and links here |
| PR labels | `clinical`, `data-protection`, `security` and `accessibility` route the PR to the matching reviewer agent before merge |
| Docs gate (`pnpm check:docs-gate`, run in CI) | A PR labelled `clinical` fails unless it changes `docs/clinical-safety/hazard-log.md` or a spec in `docs/specs/`; a PR labelled `data-protection` fails unless it changes [records-of-processing.md](records-of-processing.md) or a spec |
| CODEOWNERS | `docs/clinical-safety` is a required-review path |
| Security gates | CodeQL, gitleaks, Trivy, Syft SBOM and `pnpm audit` evidence the vulnerability-management rows of [security-checklist.md](security-checklist.md) |
| Accessibility gates | axe-core in Storybook and Playwright evidences the automated rows of [accessibility-checklist.md](accessibility-checklist.md) |
| Release checklist | The `release` skill asks for the clinical safety case delta, the manual screen-reader pass record and the sub-processor register review |

## Keeping these current

- Change a checklist in the same PR as the code that changes the answer (master prompt section 20, rule 7).
- New personal data fields go into [records-of-processing.md](records-of-processing.md) and the export schema in the same PR (definition of done, section 19).
- A new third party that receives personal data goes into [sub-processors.md](sub-processors.md) and the [DPIA template](dpia-template.md) before it is used (section 20, rule 8).
- Every phase gate re-reads each checklist's "Phase" column and updates the status.
