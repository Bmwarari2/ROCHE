# Sub-processor register

| Item | Value |
| --- | --- |
| Law | UK GDPR Art 28(2) and (4); disclosure of processing outside the UK (master prompt 5.1, 6 hosting and residency rules) |
| Shown to tenants | In Harbour (Settings, Data protection, Sub-processors), filtered to the features each tenant has enabled |
| Change notice | At least `[30]` days before a new or replacement sub-processor processes tenant data ([DPA clause 6](dpa-article-28-template.md#6-sub-processors-art-282-283d-284)) |
| Owner | `[Thapsus DPO or named lead - human action]` |
| Last reviewed | 31 October 2026: production hosting moved to Google Cloud ([ADR-0098](../decisions/0098-production-on-google-cloud.md)) |

Rule: a third-party service that would receive personal data is added here, and to the [DPIA template](dpia-template.md), before it is used (master prompt section 20, rule 8). Production personal data lives only in Google Cloud europe-west2 (London), where an organisation policy refuses resources in any other location ([ADR-0098](../decisions/0098-production-on-google-cloud.md)).

## 1. In use

| Sub-processor | Service | Purpose | Personal data | Where processed | Transfer safeguard | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Google Cloud EMEA Limited | Cloud SQL for PostgreSQL (regional high availability, CMEK), Cloud Storage (CMEK), Cloud Run, Cloud KMS, Secret Manager, Artifact Registry, Cloud Logging and Monitoring, external HTTPS load balancer with Cloud Armor and Cloud CDN | Hosting, storage, backups, compute for the API, workers, PowerSync and Flagsmith, under the Google Cloud Data Processing Addendum (CDPA) | All tenant data | Google Cloud europe-west2 (London) | Stored and processed in the UK. Support access by Google staff outside the UK is covered by the CDPA, which incorporates the UK International Data Transfer Addendum to the EU SCCs `[to be confirmed when signed - human action H-980]`. Cloud CDN caches only static assets, never API responses with personal data | In use (CDPA to be signed, H-980) |
| Email provider `[not yet chosen - human action H-08]` | Transactional email, reached through Harbour's SMTP adapter | Transactional email: invitations, sign-in and security notices, notifications | Recipient email address and name; message content kept to the minimum and without care details | UK or EU processing (required), under a data processing agreement | None needed (UK), or UK adequacy regulations for the EEA | Not yet chosen: joins this register by name when chosen (H-08); production email stays off until then |
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
| Email provider `[not yet chosen - human action H-08]` | Transactional email, reached through the SMTP adapter | Telling a family member who opted in that there is a new update, with a link to the portal; address verification | Family member's email address; an approved generic line and a link (no name, no update content); bounce and complaint notifications | UK or EU processing, as above | As above | Pending: extends the email provider entry above to family members once a provider is chosen (H-08) and the DPIA covers them (H-106) |
| UK SMS gateway `[provider TBC - human action H-09, H-105]` | SMS | The same notice by text message, verification codes, STOP and START replies, delivery receipts | Family member's mobile number; the approved generic line and link; replies limited to keywords | United Kingdom only: personal data stays in the UK (master prompt 6), so a provider that processes or routes numbers or messages outside the UK is not eligible, by ADR or otherwise | None needed (UK) | Pending: to be chosen, contracted and added to the DPIA (H-105); a mock adapter with the port contract tests until then |
| Expo (650 Industries) | Expo push notification service | The same notice in the family app mode (MOB-004, Phase 4), and push receipts | Family member's device push token (an online identifier); the approved generic line, no name and no update content | United States | `[UK Extension to the EU-US Data Privacy Framework, or IDTA - DPO to confirm for family members, human action H-112]` | Pending: extends the Expo entry above to family members; not switched on until the safeguard is confirmed and the DPIA covers family members (H-106, H-112) |
| Apple (APNs) and Google (Firebase Cloud Messaging) | Platform push delivery, reached through Expo | Final delivery of the family notice to the device | Family member's device push token; content as above | United States and global | As above `[DPO to confirm, human action H-112]` | Pending, as above |

## 2. Self-hosted components (not separate sub-processors)

| Component | Why it is not a sub-processor |
| --- | --- |
| PowerSync (sync service and its bucket-storage Postgres) | Self-hosted by Thapsus on Cloud Run in Google Cloud europe-west2, under the Google Cloud entry above; the vendor receives no tenant data |
| Flagsmith (feature flags) | Self-hosted by Thapsus in Google Cloud europe-west2; flag evaluations use tenant, location and role IDs only |
| pg-boss, Typst, Playwright (PDF), antivirus scanning | Run inside Thapsus's Google Cloud projects (antivirus as a ClamAV sidecar beside the API on Cloud Run) |

## 3. Optional AI providers (off by default, enabled per tenant)

Used only when a tenant enables the AI module after signing the DPIA AI addendum. Data is pseudonymised before sending; no provider may train on tenant data; prompts and responses are audited for 12 months.

| Sub-processor | Service | Geography | Retention by provider | Status |
| --- | --- | --- | --- | --- |
| Amazon Web Services | Amazon Bedrock, in-Region models in London | AWS eu-west-2 (London) | No storage of prompts or outputs by Bedrock for model training `[confirm current Bedrock terms - human action]` | Default provider when AI is enabled |
| Amazon Web Services | Amazon Bedrock, Claude models via EU-geography cross-region inference | EU regions in the Bedrock EU inference profile (whether it includes London is unconfirmed); data processed outside the UK | As above | Optional per tenant |
| Anthropic | Claude via the Anthropic API under a zero-data-retention agreement | As stated in [Anthropic's data residency documentation](https://platform.claude.com/docs/en/build-with-claude/data-residency) for the configuration chosen; outside the UK `[confirm and state before enabling - human action]` | Zero data retention under signed agreement `[human action]` | Optional per tenant |
| Tenant's own provider (bring your own key) | Tenant-chosen model API | Stated by the tenant | Under the tenant's own contract with the provider; Thapsus acts only as a conduit | Optional per tenant |

Amazon Bedrock is an AI provider only. Since [ADR-0098](../decisions/0098-production-on-google-cloud.md) AWS no longer hosts Harbour, so a tenant that chooses Bedrock adds Amazon Web Services as a separate sub-processor for the AI module, reached from the AI gateway in Google Cloud. Whether Bedrock stays the default provider is `[to be decided by ADR - engineering and DPO]`.

Sources: [Bedrock model and region support](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html), [Bedrock inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html).

## 4. Conditional (only if an ADR adopts them)

| Sub-processor | Condition | Geography |
| --- | --- | --- |
| Vercel (`lhr1`) or Fly.io (`lhr`) | If an ADR moves the stateless web tier off Cloud Run; the web tier renders personal data, so it would be a sub-processor | London region |
| Supabase | If an ADR uses Supabase London for dev, staging or pilot tenants | London region |
| WorkOS | If used for enterprise SAML or OIDC SSO | `[to confirm - human action]` |

## 5. Change log

| Date | Change | Notice given to tenants |
| --- | --- | --- |
| 11 October 2026 | Register created (Phase 0) | Not applicable (no live tenants) |
| 11 October 2026 | Pending entries for family notifications: SES for family email and a UK SMS gateway (Phase 1, slice 12) | Not applicable (no live tenants); notice due before they process family data |
| 31 October 2026 | Google Cloud EMEA Limited replaces Amazon Web Services for hosting, under the CDPA (ADR-0098, H-980); Amazon SES removed (the 11 October SES entries are superseded); the email provider is not yet chosen (H-08) and production email is off until it is | Not applicable (no live tenants) |
