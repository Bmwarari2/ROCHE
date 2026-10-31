# ISO/IEC 27001:2022 Annex A: control mapping (draft)

| Item | Value |
| --- | --- |
| Standard | ISO/IEC 27001:2022, Annex A (93 controls in four themes: organisational, people, physical, technological) |
| Why | Master prompt section 2 (DSCR assurance: ISO 27001 for assured suppliers from the 1 September 2026 uplift) and section 5.3: the build produces the control mapping and evidence; certification is Thapsus's work |
| Status | **Draft mapping for the statement of applicability. Thapsus is not certified to ISO 27001 and has no ISMS in operation yet.** Scope, the statement of applicability and the certification body are human actions [H-41](../plans/human-actions.md) and [H-537](../plans/human-actions.md) |
| Companion | [cyber-essentials.md](cyber-essentials.md), [security-checklist.md](security-checklist.md) (OWASP ASVS 5.0 L2 and MASVS L2), [gdpr-checklist.md](gdpr-checklist.md) |
| Last reviewed | 31/10/2026 (Phase 2 slice 80, refreshed for the Google Cloud Terraform) |

Statuses: **Met** (in place, with evidence below), **Partly met** (in place for part of the scope, or
built but not switched on), **Gap** (not in place), **Inherited** (provided by Google Cloud under the shared
responsibility model; the evidence is Google Cloud's own ISO 27001 certificate and SOC 2 reports
(check current scope), which Thapsus keeps on file once the organisation is set up). Every gap names its owner: "Brian" is the Thapsus
director (owner of the human actions), "Engineering" is the build. The proposed ISMS scope is the
Harbour service (code, infrastructure, operations) and the Thapsus people and devices that build
and run it; H-537 decides it.

Production runs on Google Cloud europe-west2 (London) since [ADR-0098](../decisions/0098-production-on-google-cloud.md). The AWS Terraform that was
the evidence for the cloud controls is replaced by Google Cloud Terraform and its tests. Evidence
still on a branch that reaches `main` through `integration/google-cloud` is tagged:

| Tag | Branch | What it holds |
| --- | --- | --- |
| [infra] | `feat/infra-google-cloud` | `infra/bootstrap` (organisation policies, Data Access audit logs, Workload Identity Federation, the CI deny policy), `infra/modules/*` and `infra/envs/{dev,staging,prod}`, with `terraform test` suites `infra/bootstrap/tests/bootstrap.tftest.hcl`, `infra/modules/github_wif/tests/roles.tftest.hcl` and `infra/modules/harbour_stack/tests/plan.tftest.hcl`; `.github/workflows/terraform.yml` (fmt, validate, test, tflint, Trivy, plan on pull requests, apply from `main`); pgAudit in `db:bootstrap` |
| [adapters] | `feat/api-google-cloud-adapters` | Cloud Storage with the customer-managed key and every generation deleted (`apps/api/src/integrations/storage.ts`, `storage.test.ts`), the SMTP adapter (`smtp.test.ts`), production configuration checks (`apps/api/test/config.test.ts`) |
| [shred] | `feat/platform-crypto-shred` | Per-organisation envelope encryption and two-person crypto-shredding (ADR-0109 on that branch; `apps/api/src/integrations/envelope.ts`, `tenant-keys.ts`, `apps/api/src/routes/shred.ts`, migration 0117; `apps/api/test/crypto-shred.test.ts`, `packages/db/test/crypto-shred.test.ts`) |

**Met** for a cloud control means the configuration is code and a test proves it (a `terraform
test` assertion, or an application test). It becomes operating evidence for an auditor once the
first apply has run (H-04, H-1090 to H-1094 on [infra]); that is the same for every cloud control,
so it is not repeated per row. A control that needs any other human action is **Partly met** and
names it.

The management system clauses (4 to 10: context, leadership, planning, support, operation,
evaluation, improvement), including the risk assessment method, internal audit and management
review, are not Annex A controls and are not yet in place: [H-664](../plans/human-actions.md).

## Summary

| Theme | Controls | Met | Partly met | Gap | Inherited |
| --- | --- | --- | --- | --- | --- |
| 5 Organisational | 37 | 16 | 15 | 6 | 0 |
| 6 People | 8 | 0 | 2 | 6 | 0 |
| 7 Physical | 14 | 0 | 2 | 2 | 10 |
| 8 Technological | 34 | 16 | 15 | 2 | 1 |
| **All** | **93** | **32** | **34** | **16** | **11** |

Change from the previous review (26 Met, 40 Partly met): 5.17, 5.23, 8.9, 8.14, 8.20, 8.22 and 8.31
are Met on the Google Cloud Terraform and its tests; 8.8 moves from Met to Partly met because the
built images are not scanned (H-1170).

## 5 Organisational controls

| Control | Status | Evidence | Gap owner |
| --- | --- | --- | --- |
| 5.1 Policies for information security | Gap | No Thapsus information security policy. Technical rules exist: [01-CONSTRAINTS.md](../01-CONSTRAINTS.md), [security-checklist.md](security-checklist.md) | Brian (H-660) |
| 5.2 Information security roles and responsibilities | Partly met | Clinical safety officer [ADR-0006](../decisions/0006-clinical-safety-officer.md), data protection lead [ADR-0007](../decisions/0007-data-protection-officer.md), incident roles [incident-response.md](../runbooks/incident-response.md), [on-call.md](../runbooks/on-call.md), code owners `.github/CODEOWNERS`; no named information security lead | Brian (H-660) |
| 5.3 Segregation of duties | Partly met | Product: `packages/domain/src/platform/separation-of-duties.ts` (controlled drugs, money, incident close, ledger, DPIA sign-off). Thapsus: one person owns code, review and deploy today; reviewer agents in `.claude/agents/` and required reviews once branch protection is on (H-02) | Brian (H-02, H-661) |
| 5.4 Management responsibilities | Gap | Management direction for staff and suppliers to apply the policies | Brian (H-660, H-664) |
| 5.5 Contact with authorities | Partly met | ICO (breach clock, [breach-response.md](breach-response.md); registration [H-31](../plans/human-actions.md)), CQC and safeguarding bodies in the incident runbook; NCSC reporting not written down | Brian (H-31, H-660) |
| 5.6 Contact with special interest groups | Gap | No membership recorded (for example the NCSC's information sharing) | Brian (H-660) |
| 5.7 Threat intelligence | Partly met | Renovate vulnerability alerts, CodeQL, Trivy and `pnpm audit` feeds (`renovate.json`, `.github/workflows/`); threat models per module spec ([security-checklist.md](security-checklist.md) V15); no threat intelligence process | Brian (H-660) |
| 5.8 Information security in project management | Met | Working agreement (master prompt section 20); pull request template with clinical-safety and data-protection impact (`.github/pull_request_template.md`); reviewer agents (`.claude/agents/security-reviewer.md`, `clinical-safety-reviewer.md`, `accessibility-reviewer.md`); docs gate in CI ("Clinical and data-protection labels update their documents") | - |
| 5.9 Inventory of information and other associated assets | Partly met | Information: export catalogue `packages/domain/src/platform/export-catalogue.ts` (every table and column classified, `packages/db/src/export-catalogue.test.ts`), [records-of-processing.md](records-of-processing.md); software: Syft SBOM in CI; infrastructure: one Terraform root and state per Google Cloud project, `infra/envs/{dev,staging,prod}` [infra], labels on every resource. No register of Thapsus devices | Brian (H-662) |
| 5.10 Acceptable use of information and other associated assets | Gap | No acceptable use policy for Thapsus staff | Brian (H-660) |
| 5.11 Return of assets | Gap | No leaver process for Thapsus equipment and access | Brian (H-661) |
| 5.12 Classification of information | Partly met | Every field classified with its retention class ([data-standards.md](../specs/data-standards.md), [retention.md](../specs/retention.md)); special category data identified in [records-of-processing.md](records-of-processing.md); no confidentiality classification scheme for Thapsus's own documents | Brian (H-660) |
| 5.13 Labelling of information | Partly met | Exports and prints carry headers, watermarks and the "Sample" marker; signed evidence packs are watermarked ([ADR-0050](../decisions/0050-evidence-pack-links.md)); no labelling procedure for internal documents | Brian (H-660) |
| 5.14 Information transfer | Met | Data processing agreement with technical and organisational measures ([dpa-article-28-template.md](dpa-article-28-template.md) schedule 2); TLS 1.2 or higher; expiring evidence-pack links ([ADR-0050](../decisions/0050-evidence-pack-links.md)); no personal data in email bodies ([ADR-0051](../decisions/0051-personal-data-in-template-emails.md)) | - |
| 5.15 Access control | Partly met | Role and attribute access enforced in the API and in row-level security ([ADR-0002](../decisions/0002-tenancy-and-row-level-security.md), [ADR-0071](../decisions/0071-data-scope-is-per-permission.md)); `packages/domain/src/platform/access.ts`; `packages/db/test/isolation.test.ts`. A Thapsus access control policy is still to be written | Brian (H-660) |
| 5.16 Identity management | Met | Invitations and members ([platform.md](../specs/platform.md)); identity provider [ADR-0009](../decisions/0009-identity-provider.md); one identity per person, shared devices per [ADR-0025](../decisions/0025-shared-device-sign-in.md) | - |
| 5.17 Authentication information | Met | Passkeys and authenticator apps; NCSC password rules (`packages/domain/src/platform/passwords.ts`, `passwords.test.ts`); gitleaks in CI. Service secrets are regional Secret Manager secrets in europe-west2 under a customer-managed key, created empty and given values inside Google Cloud, so none is in Terraform state (`infra/modules/secret_manager/main.tf`, `infra/scripts/seed-secrets.sh` [infra]; plan test "everything_in_london": every secret regional in europe-west2); each service reads only its own (plan test "services_and_database": the web tier reads no secrets, PowerSync none of the API's, SMTP secrets unread until a provider is chosen); service account keys refused by organisation policy (`iam.disableServiceAccountKeyCreation`, `infra/bootstrap/main.tf`; bootstrap test "dev_trusts_its_own_environments_only") | - |
| 5.18 Access rights | Partly met | Product: time-boxed grants, expiring agency, external and inspector roles (`packages/domain/src/platform/access.test.ts`), break-glass reported weekly. Thapsus: no periodic access review of Google Cloud and GitHub | Brian (H-661) |
| 5.19 Information security in supplier relationships | Met | Sub-processor register and rules ([sub-processors.md](sub-processors.md)); licence allowlist [ADR-0024](../decisions/0024-licence-allowlist.md) | - |
| 5.20 Addressing information security within supplier agreements | Partly met | Data processing agreement template ([dpa-article-28-template.md](dpa-article-28-template.md)); each supplier's terms to be on file ([H-32](../plans/human-actions.md), [H-33](../plans/human-actions.md)); the Google Cloud Data Processing Addendum is not yet signed ([H-1000](../plans/human-actions.md)) | Brian (H-32, H-33, H-1000) |
| 5.21 Managing information security in the ICT supply chain | Met | SBOM (Syft), licence allowlist, dependency scanning (Trivy, `pnpm audit`), Renovate; every GitHub Action pinned by commit SHA (`.github/workflows/*.yml` [infra]); Terraform providers pinned in `.terraform.lock.hcl` per root [infra] | - |
| 5.22 Monitoring, review and change management of supplier services | Partly met | Sub-processor change notice process ([sub-processors.md](sub-processors.md), objection process [H-117](../plans/human-actions.md)); no scheduled supplier review | Brian (H-117, H-660) |
| 5.23 Information security for use of cloud services | Met | [ADR-0098](../decisions/0098-production-on-google-cloud.md): Google Cloud europe-west2, one project per environment in a Harbour folder. Organisation policy `gcp.resourceLocations` allows europe-west2 only and Data Access audit logs are on for every service (`infra/bootstrap/main.tf`; bootstrap test "dev_trusts_its_own_environments_only"); every database, backup, key, image, network, log, bucket and service is in europe-west2 (plan tests "everything_in_london" and "another_region_is_refused"); misconfiguration scanning on every change (Trivy in `.github/workflows/terraform.yml` [infra]). The contract side is under 5.20 (H-1000) | - |
| 5.24 Information security incident management planning and preparation | Met | [incident-response.md](../runbooks/incident-response.md), [breach-response.md](breach-response.md), [on-call.md](../runbooks/on-call.md) | - |
| 5.25 Assessment and decision on information security events | Met | Severity guide ([incident-response.md](../runbooks/incident-response.md)); breach severity and the reporting decision with recorded reasoning ([breach-response.md](breach-response.md) section 4) | - |
| 5.26 Response to information security incidents | Partly met | Response steps written; the 24/7 rota and paging are not in place ([H-44](../plans/human-actions.md)) | Brian (H-44) |
| 5.27 Learning from information security incidents | Met | Post-incident review section in [incident-response.md](../runbooks/incident-response.md); hazard log review when clinical | - |
| 5.28 Collection of evidence | Met | Preserve evidence before changing systems ([breach-response.md](breach-response.md) section 2); tamper-evident `audit_event` (append-only, hash chain; `packages/db/test/audit-and-history.test.ts`); Cloud Audit Logs (Admin Activity and Data Access) and pgAudit routed to a security log bucket kept 400 days or more, locked in prod, VPC flow logs and load balancer request logs (`infra/modules/observability/main.tf`, `infra/modules/network/main.tf`, `infra/modules/load_balancer/main.tf` [infra]; plan tests "dev_defaults" and "short_security_log_retention_is_refused") | - |
| 5.29 Information security during disruption | Partly met | Offline mobile is the continuity path; the downtime pack ([operations.md](../specs/operations.md)); [restore.md](../runbooks/restore.md). No business continuity plan for Thapsus | Brian (H-660) |
| 5.30 ICT readiness for business continuity | Partly met | RPO 15 minutes and RTO 4 hours ([01-CONSTRAINTS.md](../01-CONSTRAINTS.md)); Cloud SQL regional high availability, point-in-time recovery, retained backups and deletion protection in staging and prod (`infra/modules/cloud_sql_postgres/main.tf`, `infra/envs/*/main.tf` [infra]; plan test "services_and_database": the main database is REGIONAL); the restore drill has not been run ([H-45](../plans/human-actions.md)) | Engineering (H-45) |
| 5.31 Legal, statutory, regulatory and contractual requirements | Met | [gdpr-checklist.md](gdpr-checklist.md), [records-of-processing.md](records-of-processing.md), [medical-device-boundary.md](medical-device-boundary.md), DSCR assurance [ADR-0015](../decisions/0015-nhs-dscr-assurance.md), statutory figures in [rates.md](../specs/rates.md) | - |
| 5.32 Intellectual property rights | Met | Licence allowlist enforced in CI ([ADR-0024](../decisions/0024-licence-allowlist.md)); open-source stance [ADR-0019](../decisions/0019-open-source-stance.md) | - |
| 5.33 Protection of records | Met | Append-only audit and clinical records, corrections as new events; retention with legal hold and destruction certificates ([retention-and-deletion.md](retention-and-deletion.md), `packages/domain/src/platform/retention.ts`, [ADR-0031](../decisions/0031-document-storage-scanning-and-destruction.md)) | - |
| 5.34 Privacy and protection of PII | Met | [dpia-template.md](dpia-template.md), [gdpr-checklist.md](gdpr-checklist.md), [dsar-procedure.md](dsar-procedure.md), [data-protection-complaints.md](data-protection-complaints.md); no personal data in logs or fixtures (CI and review rules) | - |
| 5.35 Independent review of information security | Gap | No external penetration test or audit yet (annual test promised in the DPA; [H-41](../plans/human-actions.md)) | Brian (H-41) |
| 5.36 Compliance with policies, rules and standards for information security | Partly met | CI gates enforce the technical rules on every change; [vulnerability-exceptions.md](vulnerability-exceptions.md) records exceptions; no compliance review against Thapsus policies (none exist yet) | Brian (H-660, H-664) |
| 5.37 Documented operating procedures | Met | `docs/runbooks/` (incident response, on-call, restore, mobile release, tenant onboarding, search index, local development, access report) | - |

## 6 People controls (Thapsus staff)

| Control | Status | Evidence | Gap owner |
| --- | --- | --- | --- |
| 6.1 Screening | Gap | No screening procedure for Thapsus staff and contractors | Brian (H-661) |
| 6.2 Terms and conditions of employment | Gap | No security responsibilities in contracts | Brian (H-661) |
| 6.3 Information security awareness, education and training | Gap | Claimed in the DPA (schedule 2, "People") but no training programme or record | Brian (H-661) |
| 6.4 Disciplinary process | Gap | None for Thapsus staff | Brian (H-661) |
| 6.5 Responsibilities after termination or change of employment | Gap | No leaver process (access removal, confidentiality after leaving) | Brian (H-661) |
| 6.6 Confidentiality or non-disclosure agreements | Gap | No NDA template or register | Brian (H-661) |
| 6.7 Remote working | Partly met | All administration is through cloud services with MFA and no stored keys (GitHub OIDC); no remote working policy | Brian (H-660) |
| 6.8 Information security event reporting | Partly met | Anyone raises an incident ([incident-response.md](../runbooks/incident-response.md)); Thapsus staff log DSARs they receive ([dsar-procedure.md](dsar-procedure.md)); not yet in staff terms or training | Brian (H-661) |

## 7 Physical controls

Harbour runs only in Google Cloud data centres (europe-west2, [ADR-0098](../decisions/0098-production-on-google-cloud.md)) and Thapsus has no office or
server room in scope; the data-centre controls are inherited from Google Cloud. The controls that remain are about Thapsus devices
and home working.

| Control | Status | Evidence | Gap owner |
| --- | --- | --- | --- |
| 7.1 Physical security perimeters | Inherited | Google Cloud data centres ([ADR-0098](../decisions/0098-production-on-google-cloud.md)) | - |
| 7.2 Physical entry | Inherited | Google Cloud | - |
| 7.3 Securing offices, rooms and facilities | Inherited | Google Cloud; no Thapsus office in scope | - |
| 7.4 Physical security monitoring | Inherited | Google Cloud | - |
| 7.5 Protecting against physical and environmental threats | Inherited | Google Cloud; the main database is regional (a standby in a second London zone; plan test "services_and_database" [infra]) and Cloud Run runs across zones | - |
| 7.6 Working in secure areas | Inherited | Google Cloud | - |
| 7.7 Clear desk and clear screen | Gap | No clear desk or screen lock rule for Thapsus staff | Brian (H-660, H-662) |
| 7.8 Equipment siting and protection | Inherited | Google Cloud (no Thapsus servers) | - |
| 7.9 Security of assets off-premises | Partly met | Laptops hold no production data by design (no personal data in fixtures; production access through Google Cloud and the operator console); device rules not written | Brian (H-662) |
| 7.10 Storage media | Partly met | Production media is Google-managed and encrypted at rest, with customer-managed Cloud KMS keys on Cloud SQL, Cloud Storage, Secret Manager and Artifact Registry (`infra/modules/kms`, `cloud_sql_postgres`, `gcs_bucket`, `secret_manager`, `artifact_registry` [infra]); removable media rules for Thapsus devices not written | Brian (H-662) |
| 7.11 Supporting utilities | Inherited | Google Cloud | - |
| 7.12 Cabling security | Inherited | Google Cloud | - |
| 7.13 Equipment maintenance | Inherited | Google Cloud (servers); Thapsus devices under H-662 | - |
| 7.14 Secure disposal or re-use of equipment | Gap | No disposal procedure for Thapsus devices (document destruction is covered, [ADR-0031](../decisions/0031-document-storage-scanning-and-destruction.md)) | Brian (H-662) |

## 8 Technological controls

| Control | Status | Evidence | Gap owner |
| --- | --- | --- | --- |
| 8.1 User endpoint devices | Partly met | Harbour mobile: device unlock and auto-lock, SQLCipher store, remote wipe ([kiosk.md](kiosk.md), [security-checklist.md](security-checklist.md) MASVS rows); the root and jailbreak check is a stub (`apps/mobile/src/security/device-integrity.ts`). Thapsus devices not documented | Brian (H-662); Engineering (Phase 2 eMAR, lane G) |
| 8.2 Privileged access rights | Partly met | CI reaches Google Cloud only through Workload Identity Federation, with no service account keys (organisation policy). Separate plan, apply and release accounts per environment, each trusting one GitHub environment of this repository by numeric ids (`infra/bootstrap/main.tf`, `infra/modules/github_wif/main.tf` [infra]; bootstrap tests "dev_trusts_its_own_environments_only" and "prod_subjects_differ_from_dev"); Owner, Workload Identity Pool Admin and Project IAM Admin refused to CI (`roles.tftest.hcl`: "owner_is_refused", "workload_identity_admin_is_refused", "project_iam_admin_is_refused"); a deny policy keeps CI away from secrets, objects, logs, keys and its own federation. Still to do: protect the GitHub environments (H-1094 on [infra]); operator impersonation needs a tenant approval ticket by design but is not built (`packages/domain/src/platform/roles.ts`) | Brian (H-1094); Engineering (operator console) |
| 8.3 Information access restriction | Met | Per-permission scope and row-level security failing closed (`packages/db/test/isolation.test.ts`: "sees nothing at all without a request context (fails closed)"; `packages/db/test/rls-coverage.test.ts`); restricted silos planned ([phase-2.md](../plans/phase-2.md), ADR-0089) | - |
| 8.4 Access to source code | Partly met | Private repository ([ADR-0019](../decisions/0019-open-source-stance.md)); single code owner; branch protection not yet on ([H-02](../plans/human-actions.md)) | Brian (H-01, H-02) |
| 8.5 Secure authentication | Met | Passkeys and authenticator apps, step-up, MFA only for the session that used it (`apps/api/src/auth/`; [ADR-0072](../decisions/0072-mfa-counts-only-for-the-session-that-used-it.md); `apps/web/e2e/security.spec.ts`) | - |
| 8.6 Capacity management | Partly met | Cloud Monitoring alerts on Cloud SQL CPU, memory and storage, API 5xx and always-on services, and a billing budget (`infra/modules/observability/main.tf`, `infra/modules/budget/main.tf` [infra]); performance budgets in CI (Lighthouse CI); no capacity plan, and alert notification channels are set at apply | Engineering (capacity plan, H-1176) |
| 8.7 Protection against malware | Partly met | ClamAV scanning of uploads before they are kept ([ADR-0031](../decisions/0031-document-storage-scanning-and-destruction.md); `apps/api/test/documents.test.ts`); ClamAV runs as a sidecar beside the API on 127.0.0.1:3310 (`infra/modules/harbour_stack/services.tf` [infra]; plan test "services_and_database"); production refuses the mock scanner (`apps/api/test/config.test.ts` [adapters]); immutable images. The ClamAV image is not yet mirrored and its signature updates not set up ([H-16](../plans/human-actions.md)); Thapsus devices under H-662 | Brian (H-16, H-662) |
| 8.8 Management of technical vulnerabilities | Partly met | CodeQL, Trivy (dependencies and configuration), `pnpm audit`, Renovate; fix CVSS 7 or above within 14 days; recorded exceptions ([vulnerability-exceptions.md](vulnerability-exceptions.md)). The built container images are not scanned: Artifact Registry vulnerability scanning (`containerscanning.googleapis.com`) is not enabled in `infra/modules/project_baseline` [infra] and CI has no image scan (H-1170). The annual external test is a gap under 5.35 | Engineering (H-1170) |
| 8.9 Configuration management | Met | Everything as code: a Terraform root and state per environment, one Google Cloud project each (`infra/envs/{dev,staging,prod}` [infra]); images with immutable tags and a cleanup policy in Artifact Registry (`infra/modules/artifact_registry/main.tf` [infra]); fmt, validate, `terraform test`, tflint and Trivy (HIGH and CRITICAL fail) on every change, the plan posted to the pull request and applied from `main` only (`.github/workflows/terraform.yml` [infra]) | - |
| 8.10 Information deletion | Met | Retention, legal hold, destruction with certificates and every stored generation deleted ([retention-and-deletion.md](retention-and-deletion.md); `apps/api/src/routes/documents.ts`; `apps/api/test/documents.test.ts`; `GcsDocumentStorage.destroy` tests in `apps/api/src/integrations/storage.test.ts` [adapters]); per-organisation crypto-shredding by two people with step-up and a signed certificate (`apps/api/test/crypto-shred.test.ts` [shred]) | - |
| 8.11 Data masking | Met | Opaque ids in logs; Cloud SQL error lines carry no values and pgAudit logs relations without parameters (plan test "egress_and_edge_rules": "Database error lines must not carry values" [infra]); evidence-pack redaction ([ADR-0050](../decisions/0050-evidence-pack-links.md)) | - |
| 8.12 Data leakage prevention | Partly met | Export only by the owner with step-up, one download, audited; no email bodies with personal data ([ADR-0051](../decisions/0051-personal-data-in-template-emails.md)); browser reaches only the web origin ([ADR-0030](../decisions/0030-web-session-and-browser-security.md)); no data leakage prevention tooling on Thapsus devices | Brian (H-662) |
| 8.13 Information backup | Partly met | Cloud SQL automated backups with point-in-time recovery and a retained count, versioned Cloud Storage buckets, an audit archive bucket with a retention policy locked in prod (`infra/modules/cloud_sql_postgres/main.tf`, `infra/modules/gcs_bucket/main.tf`, `infra/modules/harbour_stack/data.tf` [infra]; [restore.md](../runbooks/restore.md)); no restore test recorded yet ([H-45](../plans/human-actions.md)) | Engineering (H-45) |
| 8.14 Redundancy of information processing facilities | Met | Cloud SQL regional high availability, a synchronous standby in a second London zone (plan test "services_and_database": "The main database must be regional"); PowerSync never below one instance (same test); Cloud Run across zones (`infra/modules/harbour_stack` [infra]); offline mobile continuity | - |
| 8.15 Logging | Met | Append-only, hash-chained `audit_event` (`packages/db/drizzle/0002_security.sql`; `packages/db/test/audit-and-history.test.ts`); pgAudit on both databases, its lines and Cloud Audit Logs to a security log bucket kept 400 days or more, locked in prod; other logs to an application bucket, both in europe-west2 (`infra/modules/observability/main.tf` [infra]; plan tests "dev_defaults", "services_and_database" and "short_security_log_retention_is_refused"); UTC timestamps | - |
| 8.16 Monitoring activities | Partly met | Log-based alerts on `worker.job.failed`, `escalation.unrouted.daily` and `security.export.foreign_rows` matched to the worker's events (plan test "dev_defaults" [infra]); Data Access audit logs on for every service (bootstrap test); weekly break-glass report. Security Command Center Standard and who receives its findings are not set up ([H-663](../plans/human-actions.md)) | Brian and Engineering (H-663) |
| 8.17 Clock synchronisation | Inherited | Cloud Run and Cloud SQL use Google-managed time synchronisation; logs are in UTC; mobile clock drift is flagged (`sync.clock_drift_flag_minutes`, [rates.md](../specs/rates.md)) | - |
| 8.18 Use of privileged utility programs | Partly met | No shell into running services (Cloud Run offers none); database access only through roles ([ADR-0002](../decisions/0002-tenancy-and-row-level-security.md)) with passwords held in Secret Manager; how an operator reaches the database in an emergency (IAM database authentication, a time-boxed grant, audited) is not written or built (H-1175) | Engineering (H-1175) |
| 8.19 Installation of software on operational systems | Met | Images built in CI from the repository and pushed with immutable tags, so a deployed revision never changes (`infra/modules/artifact_registry/main.tf` [infra]); only the release workflow deploys, through its own federated account (`.github/workflows/terraform.yml` [infra]); nothing is installed on running services | - |
| 8.20 Networks security | Met | Cloud SQL on private IP only; the API, web and PowerSync accept traffic only from the load balancer and the worker none from outside (`INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` and `INTERNAL_ONLY`); TLS 1.2 or higher at the load balancer; outbound traffic from static NAT addresses (plan tests "nothing_public" and "egress_and_edge_rules" [infra]) | - |
| 8.21 Security of network services | Partly met | Cloud Armor with the OWASP Core Rule Set preconfigured rules and a per-IP rate limit; PowerSync's admin API not served from the internet; HTTP only redirects to HTTPS; Cloud SQL requires TLS (`ssl_mode = ENCRYPTED_ONLY`) (`infra/modules/load_balancer/main.tf`, `infra/modules/cloud_sql_postgres/main.tf` [infra]; plan test "egress_and_edge_rules"). The rule versions are pinned only once read from the project ([H-140](../plans/human-actions.md), H-1095 on [infra]) | Brian (H-140) |
| 8.22 Segregation of networks | Met | A separate project, VPC network and Terraform state per environment (`infra/envs/*` [infra]); the data tier on private IP only and the worker unreachable from outside (plan test "nothing_public"); Cloud CDN serves only the web tier's static files, never pages, the API or sync (same test) | - |
| 8.23 Web filtering | Gap | No web filtering for Thapsus devices (servers make outbound calls only through the NAT gateway to named services) | Brian (H-662) |
| 8.24 Use of cryptography | Partly met | Cloud KMS regional key ring with a key per purpose, each rotated at least every 90 days (plan test "keys_rotate" [infra]), customer-managed keys on Cloud SQL, Cloud Storage, Secret Manager and Artifact Registry; per-organisation envelope encryption of every stored object with AES-256-GCM, its key wrapped by the organisation's own Cloud KMS key, and signed destruction certificates (`apps/api/src/integrations/envelope.ts`, `envelope.test.ts`, `tenant-keys.test.ts` [shred]); SQLCipher on mobile; TLS 1.2 or higher (plan test "nothing_public"). Still to do: the tenants key ring, certificate signing key and their IAM (H-1110 to H-1113 on [shred]); certificate pinning only proposed ([ADR-0028](../decisions/0028-certificate-pinning.md)) | Brian (H-1110 to H-1113); Engineering (ADR-0028) |
| 8.25 Secure development life cycle | Met | Master prompt sections 7 and 20; CI gates in `.github/workflows/ci.yml` ("Secrets (gitleaks)", "Vulnerabilities in dependencies and config (Trivy)", "Software bill of materials (Syft)", "Types", "Committed OpenAPI document matches the code", "pnpm audit (production dependencies, high and critical)", "Unit, domain and RLS isolation tests"); CodeQL | - |
| 8.26 Application security requirements | Met | OWASP ASVS 5.0 Level 2 and MASVS Level 2 ([security-checklist.md](security-checklist.md)); each module spec carries its permission matrix and rules | - |
| 8.27 Secure system architecture and engineering principles | Met | ADRs (`docs/decisions/`); tenancy and row-level security [ADR-0002](../decisions/0002-tenancy-and-row-level-security.md); per-permission scope [ADR-0071](../decisions/0071-data-scope-is-per-permission.md); web session security [ADR-0030](../decisions/0030-web-session-and-browser-security.md) | - |
| 8.28 Secure coding | Met | Biome, strict TypeScript, Zod at every boundary, parameterised SQL (Drizzle), CodeQL, security reviewer agent (`.claude/agents/security-reviewer.md`) | - |
| 8.29 Security testing in development and acceptance | Partly met | Tenant isolation, authorisation and refusal tests in CI (`packages/db/test/isolation.test.ts`, `apps/api/test/route-gates.test.ts`, `apps/web/e2e/security.spec.ts`); no external penetration test yet ([H-41](../plans/human-actions.md)) | Brian (H-41) |
| 8.30 Outsourced development | Partly met | Development is done by Thapsus with Claude Code agents under the same pull request, CI and review rules; no contract terms yet for any human contractor | Brian (H-661) |
| 8.31 Separation of development, test and production environments | Met | One Google Cloud project per environment with separate state, and CI accounts per environment that trust only that environment's GitHub environments (bootstrap test "prod_subjects_differ_from_dev" [infra]); Supabase London for dev, staging and pilots ([ADR-0008](../decisions/0008-production-hosting.md)); production personal data only in Google Cloud europe-west2 ([ADR-0098](../decisions/0098-production-on-google-cloud.md)) | - |
| 8.32 Change management | Partly met | Every change by pull request with its Terraform plan posted and checks run; applied from `main` only, through a GitHub environment (`.github/workflows/terraform.yml` [infra]); branch protection, required reviews and environment protection not yet on ([H-02](../plans/human-actions.md), H-1094 on [infra]) | Brian (H-02, H-1094) |
| 8.33 Test information | Met | No personal data in fixtures, logs or screenshots: invented people, `example.invalid` emails, 999-range NHS numbers ([01-CONSTRAINTS.md](../01-CONSTRAINTS.md)); sample data mode is flagged and removed in one step ([platform-completions.md](../specs/platform-completions.md)) | - |
| 8.34 Protection of information systems during audit testing | Gap | No rules yet for audit and penetration testing against production (scope, timing, accounts) | Brian (H-41, H-664) |

## Keeping this current

- Change this mapping in the same pull request as a change that alters a control's status (master
  prompt section 20, rule 7).
- H-537 turns the "Status" and "Evidence" columns into the statement of applicability, with the
  justification for any control excluded.
