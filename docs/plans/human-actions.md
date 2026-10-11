# Human actions

Work only a person can do (master prompt sections 3, 19 and 20). The build never waits for these;
they gate a real tenant going live, which is Brian's decision. Each item says what the build has
already produced for it. Update the status column as items are done.

Owners: **Brian** (Thapsus Cargo Ltd), **CSO** (Clinical Safety Officer, to be appointed), **DPO**
(data protection officer or named lead), **Tenant** (each care provider at onboarding).

## Accounts, credentials and provisioning (unblock CI, deploys and stores)

| # | Action | Owner | What the build produced | Unblocks | Status |
| --- | --- | --- | --- | --- | --- |
| H-01 | Create the GitHub organisation, move the repository, add a bot identity for Claude Code and authenticate `gh` | Brian | CODEOWNERS (update the team handle), workflows, PR template | Branch protection, required checks, issues | open |
| H-02 | Switch on branch protection for `main`: required status checks from `ci.yml` and `codeql.yml`, linear history, signed commits; required human review before the first real tenant | Brian | Workflows with stable job names | The merge rules in section 7 | open |
| H-03 | Provide a commit-signing key for the bot identity | Brian | Hooks and conventions | Signed commits | open |
| H-04 | AWS dev account; bootstrap the Terraform state bucket and key; run the first apply; store `AWS_DEPLOY_ROLE_ARN`, `AWS_PLAN_ROLE_ARN` and the `DEV_*` and `TF_STATE_*` repository variables | Brian | `infra/` (validated, tested with mocked providers), `infra/README.md` steps, `.github/workflows/terraform.yml` | Terraform plan and apply in CI, dev environment | open |
| H-05 | Product domain name and DNS (Route 53 zone or manual records) | Brian | ACM and CloudFront modules expecting a domain | HTTPS endpoints, passkey relying-party ID | open |
| H-06 | Mirror the PowerSync service image (and optional Flagsmith) into ECR | Brian | Task definitions and `infra/README.md` commands | Offline sync on dev | open |
| H-07 | Run `infra/scripts/seed-secrets.sh dev`, then the `migrate` ECS task | Brian | Secrets created empty by Terraform; `apps/api/dist/migrate.js` | Databases, roles, reference data on dev | open |
| H-08 | SES production access for eu-west-2 (transactional email only) | Brian | SES module, SES adapter | Email notifications beyond the sandbox | open |
| H-09 | Choose a UK SMS gateway | Brian | SMS port with a mock adapter | SMS notifications | open |
| H-10 | Expo (EAS) account; `EXPO_TOKEN` repository secret | Brian | `eas.json`, `.github/workflows/mobile.yml` | Store builds, TestFlight and Play internal testing | open |
| H-11 | Apple Developer Program (needs a D-U-N-S number) and Google Play Console in the name of Thapsus Cargo Ltd | Brian | Bundle id `uk.co.thapsus.harbour`, privacy manifest, permission strings | Store distribution | open |
| H-12 | Grafana Cloud (UK region), Sentry (EU region) and a hosted status page | Brian | Observability module, `infra/README.md` status-page steps | Monitoring and a public status page | open |
| H-13 | Decide Flagsmith hosting (self-hosted module ready, off by default) | Brian | Flagsmith task definition behind a variable | Remote flag management | open |
| H-14 | Sign in on dev with a passkey and see the empty demo home (Phase 0 human follow-up) | Brian | Web shell, `HARBOUR_DEMO_OWNER_EMAIL` option in `seed:users` | Phase 0 acceptance | open |
| H-15 | Create the first Thapsus operator: insert an `operator_user` row (role `admin`) for Brian's identity, with TOTP or a passkey enrolled | Brian | Operator console API | Tenant provisioning | open |
| H-16 | Mirror a ClamAV image into ECR and add it as a sidecar to the API task (the `ecs_service` module needs sidecar support first, an engineering follow-up); keep its signatures updated (freshclam) | Brian, Engineering | `ClamdScanner` adapter (INSTREAM on 127.0.0.1:3310), `MALWARE_SCANNER=clamd` in Terraform, ADR-0031 | Document uploads in AWS (until then they are stored quarantined and never served) | open |
| H-17 | Enable GitHub code scanning on the repository (GitHub Advanced Security for a private repository), then set `upload: always` in `.github/workflows/codeql.yml` so findings appear as code-scanning alerts | Brian | CodeQL runs on every pull request and fails on high and critical findings via `scripts/check-sarif.mjs`; SARIF kept as an artifact | Code-scanning alerts and history in GitHub | open |

## Clinical safety

| # | Action | Owner | What the build produced | Unblocks | Status |
| --- | --- | --- | --- | --- | --- |
| H-20 | Appoint a Clinical Safety Officer (registered clinician trained in clinical risk management) | Brian | [Clinical risk management plan](../clinical-safety/clinical-risk-management-plan.md) | Every item below | open |
| H-21 | Approve the clinical risk management plan; review all hazard ratings (HZ-001 to HZ-021); accept or reject the six proposed level-3 residual risks (HZ-002, HZ-003, HZ-005, HZ-008, HZ-013, HZ-014) | CSO | [Hazard log](../clinical-safety/hazard-log.md) | Safety case sign-off | open |
| H-22 | Confirm the stale-data threshold (15 minutes, HZ-002) and the clock-change rule for doses (HZ-009) | CSO | Implemented defaults and tests | Phase 1 mobile release | open |
| H-23 | Run the first hazard workshop and decide the candidate hazards listed in the log | CSO | Candidate list | Safety case v0.1 | open |
| H-24 | Sign safety case v0.0 (Phase 0) with Brian | CSO, Brian | [Safety case v0.0](../clinical-safety/safety-case/safety-case-v0.0-phase0.md) | Any real tenant | open |
| H-25 | Regulatory opinion that calculating published tools (NEWS2, MUST, Waterlow) exactly as published keeps Harbour outside the medical-device definition; confirm licence terms for using those tools in software and the authoritative Waterlow source | Brian | [Medical-device boundary](../compliance/medical-device-boundary.md) | Phase 1 validated tools release | open |
| H-26 | Accept ADR-0025 (shared and kiosk device sign-in factors) | CSO, DPO | [ADR-0025](../decisions/0025-shared-device-sign-in.md), [kiosk.md](../compliance/kiosk.md) | First shared-device deployment | open |

## Data protection and legal

| # | Action | Owner | What the build produced | Unblocks | Status |
| --- | --- | --- | --- | --- | --- |
| H-30 | Appoint a DPO or confirm Brian as named lead; check whether Article 37(1)(c) requires a designated DPO | Brian | ADR-0007, records of processing | DPIA sign-offs | open |
| H-31 | Register Thapsus with the ICO; supply registered office, company number, ICO number and security contact for the templates | Brian | Placeholders in [records of processing](../compliance/records-of-processing.md) and the DPA template | DPA and privacy notices | open |
| H-32 | Solicitor review of the DPA, privacy notice and appropriate-policy templates; set liability caps; confirm the bracketed defaults (30-day sub-processor notice, 24-hour breach notice to tenants, 2 working days to forward a DSAR or complaint, deletion 30 days after contract end, 30-day soft-delete grace) | Brian | [DPA template](../compliance/dpa-article-28-template.md), procedures | First contract | open |
| H-33 | Confirm transfer mechanisms for Expo push (APNs and FCM, US) and AI providers; confirm Bedrock terms and the Anthropic data-residency and zero-retention agreement before AI is enabled | DPO | [Sub-processors](../compliance/sub-processors.md) | Push notifications in production; AI module (Phase 6) | open |
| H-34 | Decide how AI handles free text for people who lack capacity to consent | DPO | AI guardrails in section 16 | Phase 6 | open |
| H-35 | Keep Thapsus's own controller register (staff, operators, prospects) | DPO | Operator register row noted in records of processing | Accountability | open |
| H-36 | Publish an accessibility statement | Brian | [Accessibility checklist](../compliance/accessibility-checklist.md) | Public launch | open |
| H-37 | Professional Welsh translation of the catalogues before any Welsh tenant | Brian | `packages/i18n/src/messages/cy.json` with every key marked untranslated | Welsh Active Offer | open |

## Certification, assurance and insurance

| # | Action | Owner | What the build produced | Unblocks | Status |
| --- | --- | --- | --- | --- | --- |
| H-40 | Book Cyber Essentials then Cyber Essentials Plus | Brian | [Security checklist](../compliance/security-checklist.md); control evidence from Phase 2 | DSCR assurance, council contracts | open |
| H-41 | Start ISO 27001 (Phase 2) and book an annual external penetration test | Brian | Control mapping to be drafted in Phase 2 | DSCR IG uplift (1 September 2026 rules) | open |
| H-42 | Complete the DSPT for Thapsus as an IT supplier; NHSmail | Brian | DSPT evidence tracker (Phase 2) | GP Connect (ADR-0023) | open |
| H-43 | Cyber and professional indemnity insurance | Brian | None needed | First contract | open |
| H-44 | 24/7 on-call rota and paging before the first live tenant | Brian | [On-call runbook](../runbooks/on-call.md) | Go-live | open |
| H-45 | First quarterly restore drill once staging exists | Engineering | [Restore runbook](../runbooks/restore.md) | Evidence for assurance | open |

## Product decisions still open

| # | Question | Default in force | Where |
| --- | --- | --- | --- |
| H-50 | Duty of candour written-notification timescale to encode | Tenant setting, 10 working days, flagged to verify | ADR-0021 |
| H-51 | Which councils the first clients invoice (portal template to build first) | ContrOCC CSV | Section 15.3 |
| H-52 | Does any first client employ sponsored workers? | Sponsor module stays in Phase 2 | ADR-0022 |
| H-53 | Do first clients hold DSPT "Standards Met"? | GP Connect gated per tenant | ADR-0023 |
| H-54 | Supplier-pays assurance budget versus compressing Phases 3 and 4 | Pursue assurance | ADR-0015 |
| H-55 | Prod audit archive uses S3 Object Lock COMPLIANCE for 365 days (irreversible): confirm before the first prod apply | As written in infra | `infra/README.md` |
| H-56 | Design partner care home for weekly feedback | Demo tenant only | ADR-0005 |
| H-57 | Pricing and packaging | Drafted in Phase 3 | ADR-0018 |

## Per tenant at onboarding

Sign the DPA and the DPIA (with the AI addendum if AI is enabled), complete the DCB0160 deployment
assessment ([template](../clinical-safety/dcb0160-deployment-template.md)), enrol shared devices in
MDM, sign off imported data, confirm photos for every person, approve role design and run the
[tenant onboarding](../runbooks/tenant-onboarding.md) checklist.
