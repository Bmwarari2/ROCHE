# Cyber Essentials and Cyber Essentials Plus: control mapping

| Item | Value |
| --- | --- |
| Scheme | [Cyber Essentials](https://www.ncsc.gov.uk/cyberessentials/overview) (NCSC, delivered by IASME): self-assessment, then Cyber Essentials Plus, an independent technical audit of the same controls |
| Requirements | "Cyber Essentials: Requirements for IT infrastructure" [v3.2](https://ncsc.gov.uk/files/cyber-essentials-requirements-for-it-infrastructure-v3-2.pdf) (as cited in [security-checklist.md](security-checklist.md)); H-536 confirms the version in force when the assessment is booked and re-checks this mapping against it |
| Why | Master prompt section 2 (NHS DSCR assurance roadmap) and section 5.3: organisational certifications are Thapsus's work outside the codebase; the build produces the mapping and the evidence |
| Status | **Draft mapping. Thapsus does not hold Cyber Essentials or Cyber Essentials Plus.** Booking and scope are human actions [H-40](../plans/human-actions.md) and [H-536](../plans/human-actions.md) |
| Companion | [iso27001-controls.md](iso27001-controls.md) (ISO/IEC 27001:2022 Annex A), [security-checklist.md](security-checklist.md) (OWASP ASVS and MASVS) |
| Last reviewed | 31/10/2026 (Phase 2 slice 80) |

Statuses: **Met** (the control is in place and the evidence below proves it), **Partly met** (in place
for part of the scope, or built but not yet switched on), **Gap** (not in place). Every gap names its
owner. "Brian" is the Thapsus director (owner of the human actions); "Engineering" is the build.

## 1. Scope

Cyber Essentials covers every device and service an organisation uses to handle its data, including
cloud services it administers. For Thapsus that is three parts, set finally by H-536:

| Part | What is in it | Where the evidence is |
| --- | --- | --- |
| Cloud services Thapsus administers | AWS accounts (eu-west-2) for dev, staging and prod; GitHub (the repository, Actions); Supabase London (dev, staging and pilots, [ADR-0008](../decisions/0008-production-hosting.md)); the email and other services in [sub-processors.md](sub-processors.md) | This repository: `infra/`, `.github/workflows/`, ADRs |
| The Harbour service itself | API and web containers on ECS Fargate, RDS Postgres, S3, CloudFront, WAF, PowerSync; the mobile app | This repository |
| Thapsus end-user devices | Laptops and phones Thapsus staff use to administer the above or to read tenant data during support | **None in the repository: a gap** (section 7, H-662) |

Under the shared responsibility model AWS is responsible for the physical hosts and the hypervisor;
Thapsus is responsible for how it configures the services (Cyber Essentials treats IaaS and PaaS
configuration as in scope).

## 2. Firewalls (boundary firewalls and internet gateways)

| Requirement | How it is met | Evidence | Status | Gap owner |
| --- | --- | --- | --- | --- |
| Every device in scope is protected by a correctly configured firewall | Cloud: the only internet-facing entry points are CloudFront and the application load balancer; ECS tasks and RDS sit in private subnets with no public IPs; security groups allow only the ports each tier needs; interface endpoints accept HTTPS only. Devices: see section 7 | `infra/modules/network/main.tf` (private subnets with `map_public_ip_on_launch = false`, NAT gateway, S3 gateway and interface endpoints, endpoint security group); `infra/modules/ecs_service/main.tf` (`assign_public_ip = false`); `infra/modules/rds_postgres/main.tf` (`publicly_accessible = false`) | Partly met (cloud met; devices a gap) | Brian (H-662) for devices |
| Default firewall passwords changed; administration not exposed to the internet | No firewall appliances: AWS security groups and the WAF are administered only through AWS IAM with MFA and through Terraform from GitHub Actions with OIDC (no stored keys) | `infra/modules/github_oidc/main.tf` (deploy role trusts only `main`, plan role only pull requests); `.github/workflows/terraform.yml` | Met | - |
| Inbound rules are approved, documented and removed when no longer needed | Every rule is code, reviewed in a pull request, planned on the pull request and applied from `main` only | `.github/workflows/terraform.yml` ("Plan dev", "Post the plan to the pull request", "Apply dev"); `infra/README.md` | Met (once branch protection is on: H-02) | Brian (H-02) |
| Unauthenticated inbound connections blocked by default; only what is needed allowed | HTTP only redirects to HTTPS; the WAF applies AWS managed rule groups (IP reputation, common rule set, known bad inputs, SQL injection) and a per-IP rate limit; the load balancer drops invalid headers with strictest desync mitigation | `infra/modules/alb/main.tf`; `infra/modules/waf/main.tf` (`rate-limit-per-ip`); `infra/modules/cloudfront/main.tf` (`redirect-to-https`, WAF attached) | Met | - |
| Software firewalls on devices on untrusted networks | Thapsus laptops: not documented | None | Gap | Brian (H-662) |

Known follow-ups: the WAF managed rule versions are not yet pinned ([H-140](../plans/human-actions.md));
there are no network ACLs (security groups are the boundary), which Cyber Essentials does not require.

## 3. Secure configuration

| Requirement | How it is met | Evidence | Status | Gap owner |
| --- | --- | --- | --- | --- |
| Unnecessary software, accounts and services removed or disabled | Multi-stage container images carry only the built application; containers run as a non-root user with a read-only root filesystem and every Linux capability dropped | `apps/api/Dockerfile`, `apps/web/Dockerfile` (`USER 1000:1000`); `infra/modules/ecs_service/main.tf` (`readonlyRootFilesystem = true`, `drop = ["ALL"]`, no privileged flag) | Met (cloud); devices a gap | Brian (H-662) |
| Default and guessable passwords changed | No default credentials in deployed environments: the database master password is generated and held by AWS; application secrets come from Secrets Manager; local and CI-only test values are listed in the gitleaks allowlist and never deployed | `infra/modules/rds_postgres/main.tf` (`master_user_secret_kms_key_id`); `infra/scripts/seed-secrets.sh`; `.gitleaks.toml` | Met | - |
| Auto-run disabled; configuration hardened and reviewed | Infrastructure is scanned for misconfiguration on every change (Trivy, HIGH and CRITICAL fail the build), linted and unit-tested; accepted exceptions carry written reasons inline | `.github/workflows/terraform.yml` ("Trivy configuration scan", "tflint", "terraform test"); `.github/workflows/ci.yml` ("Vulnerabilities in dependencies and config (Trivy)") | Met (cloud) | - |
| Web-facing configuration hardened | TLS 1.2 or higher everywhere (CloudFront `TLSv1.2_2021`, load balancer `ELBSecurityPolicy-TLS13-1-2-2021-06`, RDS `rds.force_ssl` and `ssl_min_protocol_version`); per-request nonce Content Security Policy, HSTS and the other security headers | `infra/modules/cloudfront/main.tf`; `infra/modules/alb/variables.tf`; `infra/modules/rds_postgres/main.tf`; `apps/web/src/proxy.ts`; `apps/web/next.config.ts`; `apps/api/src/app.ts` (`secureHeaders()`); `apps/web/src/lib/csp.test.ts` | Met | - |
| Device locking (PIN, password or biometric) | Harbour mobile: device unlock and auto-lock as master prompt section 17.2 sets; Thapsus devices not documented | [kiosk.md](kiosk.md); [security-checklist.md](security-checklist.md) (MASVS rows) | Partly met | Brian (H-662) |

## 4. Security update management

| Requirement | How it is met | Evidence | Status | Gap owner |
| --- | --- | --- | --- | --- |
| Software is licensed and supported; unsupported software removed | Node 22 LTS and supported base images; Postgres 17 on RDS; dependency licences checked against the allowlist on every change | `.nvmrc`; `apps/*/Dockerfile` (`node:22-bookworm-slim`); `.github/workflows/ci.yml` ("Dependency licences are on the allowlist"); [ADR-0024](../decisions/0024-licence-allowlist.md) | Met (cloud and code) | - |
| High and critical updates applied within 14 days of release | Renovate raises updates weekly and vulnerability fixes at any time; `pnpm audit` (high and critical), Trivy and CodeQL fail the build; the rule "fix CVSS 7 or above within 14 days" is policy; exceptions expire and are recorded | `renovate.json` (`vulnerabilityAlerts`); `.github/workflows/ci.yml` ("pnpm audit (production dependencies, high and critical)"); `.github/workflows/codeql.yml` ("High and critical security findings fail the build", `scripts/check-sarif.mjs`); [vulnerability-exceptions.md](vulnerability-exceptions.md); [security-checklist.md](security-checklist.md) | Met (code and images) | - |
| Managed services patched | RDS minor version upgrades and ECS Fargate platform patching are AWS-managed; images are rebuilt on each release and scanned on push | `infra/modules/rds_postgres/main.tf`; `infra/modules/ecr/main.tf` (`scan_on_push`, immutable tags) | Met | - |
| Devices updated within 14 days | Thapsus laptops and phones: not documented | None | Gap | Brian (H-662) |

Follow-up: container base images are pinned by tag, not by digest; Renovate keeps them current. Pinning
by digest is an engineering improvement, not a Cyber Essentials requirement.

## 5. User access control

| Requirement | How it is met | Evidence | Status | Gap owner |
| --- | --- | --- | --- | --- |
| Accounts created through an approval process, unique per person, removed when no longer needed | Harbour: members are invited by a holder of `platform.user.manage` with step-up and removed with their sessions; agency, external and inspector roles must carry an expiry. Cloud: GitHub and AWS accounts per person (H-01) | [platform.md](../specs/platform.md) (invitations, members); `packages/domain/src/platform/access.test.ts` ("requires an expiry on agency, external and inspector roles"); [H-01](../plans/human-actions.md) | Partly met (product met; Thapsus account joiner and leaver process not written) | Brian (H-661) |
| Least privilege; administrative accounts used only for administration | Harbour: permissions `module.resource.action` with per-permission scope, enforced in the API and again by Postgres row-level security, failing closed. CI: the plan role is read-only with guardrails, the deploy role is custom with guardrails | `packages/domain/src/platform/permissions.ts`, `roles.ts`, `access.ts`; [ADR-0002](../decisions/0002-tenancy-and-row-level-security.md), [ADR-0071](../decisions/0071-data-scope-is-per-permission.md); `packages/db/test/isolation.test.ts`, `packages/db/test/rls-coverage.test.ts`; `infra/modules/github_oidc/main.tf` | Partly met (the deploy role is still to be tightened with IAM Access Analyzer, noted in the module) | Engineering (infra follow-up) |
| Multi-factor authentication on cloud services and for administrative access | Harbour: passkeys and authenticator apps; MFA for every role that reads care records; step-up for controlled drugs, money, export and break-glass; MFA counts only for the session that used it. AWS and GitHub: MFA required for people (H-01, H-662) | `apps/api/src/auth/better-auth.ts`, `apps/api/src/auth/session-factor.ts`; [ADR-0009](../decisions/0009-identity-provider.md), [ADR-0072](../decisions/0072-mfa-counts-only-for-the-session-that-used-it.md); `apps/web/e2e/security.spec.ts` | Partly met (product met; Thapsus cloud MFA not evidenced) | Brian (H-662) |
| Password-based authentication protected (throttling, no weak passwords) | NCSC rules: 12 characters or more, a deny list, no forced expiry, throttling not lockout | `packages/domain/src/platform/passwords.ts`, `passwords.test.ts`; [security-checklist.md](security-checklist.md) V6 | Met | - |
| Administrative accounts not used for email or browsing | Thapsus operating practice: not documented | None | Gap | Brian (H-660) |

## 6. Malware protection

| Requirement | How it is met | Evidence | Status | Gap owner |
| --- | --- | --- | --- | --- |
| Malware protection on every device in scope (anti-malware, application allow-listing or sandboxing) | Servers: immutable containers with a read-only filesystem (sandboxed, built only from the repository). Uploaded files: scanned with ClamAV before they are kept; a file that fails is refused, one that cannot be scanned is kept quarantined. Devices: not documented | `apps/api/src/integrations/storage.ts` (ClamAV INSTREAM); [ADR-0031](../decisions/0031-document-storage-scanning-and-destruction.md); `apps/api/test/documents.test.ts` ("refuses a file that fails the malware scan and stores nothing"); `infra/modules/harbour_stack/services.tf` | Partly met (the ClamAV sidecar is not yet deployed: [H-16](../plans/human-actions.md); devices a gap) | Brian (H-16, H-662) |
| Mobile apps from trusted stores only | The Harbour app is distributed through the App Store and Google Play (managed distribution, [ADR-0010](../decisions/0010-app-store-distribution.md)); the root and jailbreak check that blocks eMAR is a stub until the eMAR slice | `apps/mobile/src/security/device-integrity.ts` (stub, TODO for Phase 2 eMAR); [security-checklist.md](security-checklist.md) MASVS rows | Partly met | Engineering (Phase 2 eMAR, lane G) |

## 7. Thapsus end-user devices (the largest gap)

Nothing in the repository describes the laptops and phones Thapsus staff use. For Cyber Essentials
they are in scope and each needs: an inventory; a supported, updated operating system (updates
within 14 days); the device firewall on; anti-malware (the built-in Microsoft Defender or Apple
XProtect is accepted); full-disk encryption; a screen lock; no administrative use for day-to-day
work; and MFA on the cloud accounts used from them. Owner: Brian, [H-662](../plans/human-actions.md).

## 8. Cyber Essentials Plus

The Plus audit tests the same controls: an external vulnerability scan of internet-facing services,
internal scans of a sample of devices, checks that malware protection and updates work, and MFA
checks on cloud accounts. Before booking (H-536): close the gaps above, pin the WAF rules (H-140),
deploy the ClamAV sidecar (H-16), switch on branch protection (H-02) and run the first restore drill
([H-45](../plans/human-actions.md), not a Cyber Essentials control but asked for alongside it).
