# Google Cloud adapter follow-ups (#164 security review)

Branch `fix/gcp-adapter-followups`, cut from `origin/integration/google-cloud`. It closes the four
Lows from the security review of PR #164.

## What changed

- **L1, buckets checked at start** (`apps/api/src/integrations/documents.ts`, `server.ts`,
  `jobs/worker.ts`):
  - In production, the API and the worker call `health()` on both buckets before they serve or
    delete anything.
  - They refuse to start if a bucket is unreachable, outside europe-west2, not encrypted by default
    with the configured key, or keeps soft-deleted copies.
  - Soft-deleted copies would outlive `destroy()`, so a destruction certificate would be untrue.
  - The error names the bucket's role (documents or exports) and the problem, never a key or an
    object.
- **L2, sender domains** (`config.ts`, `integrations/adapters.ts`, `routes/integrations.ts`):
  - A new setting, `SMTP_ALLOWED_FROM_DOMAINS`, lists the domains an organisation's sender address
    may use. A domain matches exactly, never a subdomain or a look-alike.
  - It is required in production once `SMTP_HOST` is set, and must list domain names only.
  - Outside production it defaults to the invented `example.invalid`.
  - Saving an `smtp` connection with any other sender is refused (422).
  - Each send checks it again, so a row saved before the rule, or a domain since removed, sends
    nothing (`SenderNotAllowed`, not retried).
- **L3, secret names** (`integrations/secret-ref.ts`, `routes/integrations.ts`):
  - An integration secret must be a regional Secret Manager secret in europe-west2, in this
    environment's `GCP_PROJECT_ID`.
  - It must carry the organisation's own prefix: `harbour_int_<tenant id>_<name>`, mirroring the
    SSO keys' `harbour_sso_<tenant id>_<name>`.
  - No organisation can name another's credential, an SSO key or a platform secret.
  - With no project configured, every secret reference is refused.
  - Refusals never echo the name. OpenAPI and the client are regenerated.
- **L4, no fallback** (`documents.ts`): `DOCUMENT_STORAGE=gcs` without the project, a bucket or the
  key now throws in every environment, rather than quietly keeping documents on local disk.

## For infra

- IAM can confine the API's Secret Manager access to `harbour_int_` and `harbour_sso_` ids.
- The production environment must set `SMTP_ALLOWED_FROM_DOMAINS` when a relay is chosen.

## Human actions logged

- None.

## Tests

- **New** `secret-ref.test.ts`. It covers:
  - the organisation's own secret, with and without a version;
  - another organisation's secret, an SSO key, a platform secret, another project, another region,
    a name reaching past its prefix and an AWS ARN;
  - no project configured;
  - sender domains: exact match, case, subdomains, look-alikes, two addresses, display names, and no
    domains at all.
- **New** `documents.test.ts`:
  - startup refusal for each bucket and each problem, with no check outside production;
  - a throw for each missing setting;
  - Cloud Storage when everything is set.
- **Updated**:
  - `smtp.test.ts`: a send from a disallowed sender is refused without reaching the transport.
  - `config.test.ts`: the new setting's rules.
  - `operator-and-integrations.test.ts`: a disallowed sender, another organisation's secret, an SSO
    key, and a secret with no project configured are each refused through the API.
- **Results**:
  - `pnpm lint` and `pnpm typecheck` pass.
  - API: 91 files, 1903 tests pass.
  - Domain: 6278 tests pass.
  - The API build bundles cleanly.
- **Not called**: no real cloud service.
