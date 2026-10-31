# Sub-processor register

| Item | Value |
| --- | --- |
| Law | UK GDPR Art 28(2) and (4); disclosure of processing outside the UK (master prompt 5.1, 6 hosting and residency rules) |
| Shown to tenants | In Harbour (Settings, Data protection, Sub-processors), filtered to the features each tenant has enabled |
| Change notice | At least `[30]` days before a new or replacement sub-processor processes tenant data ([DPA clause 6](dpa-article-28-template.md#6-sub-processors-art-282-283d-284)) |
| Owner | `[Thapsus DPO or named lead - human action]` |
| Last reviewed | 11 October 2026, Phase 0 |

Rule: a third-party service that would receive personal data is added here, and to the [DPIA template](dpia-template.md), before it is used (master prompt section 20, rule 8). Production personal data lives only in AWS eu-west-2 (London).

## 1. In use

| Sub-processor | Service | Purpose | Personal data | Where processed | Transfer safeguard | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Amazon Web Services | RDS (Postgres, Multi-AZ), S3 (SSE-KMS), ECS Fargate, KMS, Secrets Manager, CloudWatch, CloudFront, WAF | Hosting, storage, backups, compute for the API, workers, PowerSync and Flagsmith | All tenant data | AWS eu-west-2 (London) | None needed (UK). CloudFront edge locations cache only static assets, never API responses with personal data | In use |
| Amazon Web Services | Simple Email Service (SES) | Transactional email: invitations, sign-in and security notices, notifications | Recipient email address and name; message content kept to the minimum and without care details | AWS eu-west-2 (London) | None needed (UK) | In use |
| Expo (650 Industries) | Expo push notification service | Delivering push notifications to the mobile apps | Device push token (an online identifier); notification content contains **no personal data** (for example "You have 3 new tasks"), only opaque IDs the app resolves locally | United States | `[UK Extension to the EU-US Data Privacy Framework, or IDTA - DPO to confirm, human action]` | In use once mobile push is switched on |
| Apple (APNs) and Google (Firebase Cloud Messaging) | Platform push delivery, reached through Expo | Final delivery of push notifications to devices | Device push token; content as above | United States and global | As above `[DPO to confirm, human action]` | In use once mobile push is switched on |
| Functional Software Inc. (Sentry) | Error monitoring | Diagnosing application errors | Error data scrubbed before sending: opaque IDs only, no names, NHS numbers, free text, request bodies or IP addresses | Sentry EU region (EEA), see [Sentry data location](https://docs.sentry.io/organization/data-storage-location/) | UK adequacy regulations for the EEA | In use |
| Grafana Labs (Grafana Cloud) | Traces, metrics and logs (OpenTelemetry) | Operating and diagnosing the service | Structured logs and traces with opaque IDs only; no personal data by design | Grafana Cloud UK region, see [Grafana Cloud regions](https://grafana.com/docs/grafana-cloud/account-management/regional-availability/) | None needed (UK) | In use |
| UK SMS gateway `[provider TBC - human action]` | SMS | SMS notifications and SMS MFA where documented as an exception | Phone number; short message without care details | United Kingdom (required) | None needed (UK) | To be selected |

### Pending: family notifications (Phase 1, slice 12)

Family members and representatives become a new group of data subjects for these services when the
family feed's notifications switch on ([comms.md](../specs/comms.md) rules 13 to 15). Each entry
needs the DPA check, the DPIA update and tenant notice before it processes family data.

| Sub-processor | Service | Purpose | Personal data | Where processed | Transfer safeguard | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Amazon Web Services | Simple Email Service (SES) | Telling a family member who opted in that there is a new update, with a link to the portal; address verification | Family member's email address; an approved generic line and a link (no name, no update content); bounce and complaint notifications | AWS eu-west-2 (London) | None needed (UK) | Pending: extends the SES entry above to family members once the DPIA covers them (H-106) |
| UK SMS gateway `[provider TBC - human action H-09, H-105]` | SMS | The same notice by text message, verification codes, STOP and START replies, delivery receipts | Family member's mobile number; the approved generic line and link; replies limited to keywords | United Kingdom only: personal data stays in the UK (master prompt 6), so a provider that processes or routes numbers or messages outside the UK is not eligible, by ADR or otherwise | None needed (UK) | Pending: to be chosen, contracted and added to the DPIA (H-105); a mock adapter with the port contract tests until then |
| Expo (650 Industries) | Expo push notification service | The same notice in the family app mode (MOB-004, Phase 4), and push receipts | Family member's device push token (an online identifier); the approved generic line, no name and no update content | United States | `[UK Extension to the EU-US Data Privacy Framework, or IDTA - DPO to confirm for family members, human action H-112]` | Pending: extends the Expo entry above to family members; not switched on until the safeguard is confirmed and the DPIA covers family members (H-106, H-112) |
| Apple (APNs) and Google (Firebase Cloud Messaging) | Platform push delivery, reached through Expo | Final delivery of the family notice to the device | Family member's device push token; content as above | United States and global | As above `[DPO to confirm, human action H-112]` | Pending, as above |

## 2. Self-hosted components (not separate sub-processors)

| Component | Why it is not a sub-processor |
| --- | --- |
| PowerSync (sync service and its bucket-storage Postgres) | Self-hosted by Thapsus in AWS eu-west-2 under the AWS entry above; the vendor receives no tenant data |
| Flagsmith (feature flags) | Self-hosted by Thapsus in AWS eu-west-2; flag evaluations use tenant, location and role IDs only |
| pg-boss, Typst, Playwright (PDF), antivirus scanning | Run inside Thapsus's AWS account |

## 3. Optional AI providers (off by default, enabled per tenant)

Used only when a tenant enables the AI module after signing the DPIA AI addendum. Data is pseudonymised before sending; no provider may train on tenant data; prompts and responses are audited for 12 months.

| Sub-processor | Service | Geography | Retention by provider | Status |
| --- | --- | --- | --- | --- |
| Amazon Web Services | Amazon Bedrock, in-Region models in London | AWS eu-west-2 (London) | No storage of prompts or outputs by Bedrock for model training `[confirm current Bedrock terms - human action]` | Default provider when AI is enabled |
| Amazon Web Services | Amazon Bedrock, Claude models via EU-geography cross-region inference | EU regions in the Bedrock EU inference profile (whether it includes London is unconfirmed); data processed outside the UK | As above | Optional per tenant |
| Anthropic | Claude via the Anthropic API under a zero-data-retention agreement | As stated in [Anthropic's data residency documentation](https://platform.claude.com/docs/en/build-with-claude/data-residency) for the configuration chosen; outside the UK `[confirm and state before enabling - human action]` | Zero data retention under signed agreement `[human action]` | Optional per tenant |
| Tenant's own provider (bring your own key) | Tenant-chosen model API | Stated by the tenant | Under the tenant's own contract with the provider; Thapsus acts only as a conduit | Optional per tenant |

Sources: [Bedrock model and region support](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html), [Bedrock inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html).

## 4. Conditional (only if an ADR adopts them)

| Sub-processor | Condition | Geography |
| --- | --- | --- |
| Vercel (`lhr1`) or Fly.io (`lhr`) | If an ADR moves the stateless web tier off ECS; the web tier renders personal data, so it would be a sub-processor | London region |
| Supabase | If an ADR uses Supabase London for dev, staging or pilot tenants | London region |
| WorkOS | If used for enterprise SAML or OIDC SSO | `[to confirm - human action]` |

## 5. Change log

| Date | Change | Notice given to tenants |
| --- | --- | --- |
| 11 October 2026 | Register created (Phase 0) | Not applicable (no live tenants) |
| 11 October 2026 | Pending entries for family notifications: SES for family email and a UK SMS gateway (Phase 1, slice 12) | Not applicable (no live tenants); notice due before they process family data |

## Payroll providers (Phase 2, slice 76; ADR-0097)

An organisation's payroll provider (Xero Payroll UK, Staffology, Sage or BrightPay) is the organisation's own processor, under the organisation's own contract with it: not a Thapsus sub-processor (H-520 recommended answer, applied 31/10/2026; the DPO confirms it at testing). Harbour sends a locked pay run's figures to it only when someone in the organisation exports them, with step-up. A file export is downloaded by that person and moved by the organisation. The Xero Payroll UK adapter sends over its API to the organisation's own Xero account, with tokens the organisation granted, kept in the managed secret store. Before the adapter is switched on, the DPO records where Xero processes the data and the transfer mechanism if it is outside the UK (H-1192). What leaves is the payroll reference, hours, pay elements, the total, holiday accrued and the auto-enrolment flags: never a name, date of birth, NI number, bank detail or health information.

