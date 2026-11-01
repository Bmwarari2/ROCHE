# The e-learning content origin on Google Cloud

Branch `feat/work-elearning` (slice 43). `origin/main` is merged in, bringing Google Cloud (#164,
ADR-0098). The slice's AWS edge (a CloudFront distribution and Route 53 records for its separate
content origin) is ported to the Google Cloud stack. The rules stay the same (ADR-0093, security
review H1 and M4).

## What changed

- **Load balancer** (`infra/modules/load_balancer`, new `learn` input):
  - A second host, `learn.<elearning_domain_name>`, on the same global load balancer.
  - Its own Certificate Manager DNS authorisation and certificate, for that one host, in the
    certificate map.
  - Its own backend to the web tier, with no caching. That backend sends `Referrer-Policy:
    no-referrer`, a closed `Permissions-Policy`, `nosniff` and HSTS. It adds no X-Frame-Options,
    because the app frames the runtime page, whose own frame-ancestors decides who may.
  - Only `/learn/*` is forwarded. A Cloud Armor rule (priority 150, matching the whole host)
    answers every other path on that host with a fixed 404 before any backend, so no app page,
    route handler or static file is ever served from that origin.
  - The host keeps every other Cloud Armor rule: OWASP CRS and rate limiting.
- **`harbour_stack`**:
  - New settings: `elearning_domain_name` and `elearning_dns_zone_name`.
  - The `elearning_is_another_site` check is kept: the content domain is never `domain_name`, under
    it, or above it.
  - When the content domain's Cloud DNS zone is in the project, an A record for the host and the
    certificate's authorisation CNAME are created there. Otherwise both are listed in
    `manual_elearning_dns_records`.
  - New secret `api-elearning-launch-secret`, given to the API as `ELEARNING_LAUNCH_SECRET` and
    seeded by `infra/scripts/seed-secrets.sh`.
  - The web service gets `ELEARNING_ORIGIN`.
- **Environments** (`infra/envs/{dev,staging,prod}`): they pass `elearning_dns_zone_name` in place of
  the Route 53 zone id. The variables and tfvars examples are updated.
- **Removed**: the slice's AWS-only changes to the deleted `cloudfront` and `ecs_service` modules,
  which have no counterpart on main.
- **Storage**: the slice's `getRange` on the storage port (reading one file's bytes out of a stored
  package) merged into the Cloud Storage adapter still using S3 calls. It now reads an inclusive
  range from Cloud Storage. The port contract test covers it for local disk and Cloud Storage.
- **Docs**: `infra/README.md` gains a row for the content host, and `ELEARNING_LAUNCH_SECRET` in the
  secrets list. ADR-0093, `docs/specs/workforce.md` section 14.4 and human actions H-1010 and
  H-1011 now describe the Google Cloud layout instead of CloudFront and Route 53.

## Note for the lead

- The brief said "only `/learn/*` forwarded to the API". The slice forwards it to the web tier (the
  Next.js runtime page), so this port does too.

## Human actions logged

- None new. H-1010 (the content domain, its DNS and certificate) and H-1011 (seeding
  `api-elearning-launch-secret` in environments seeded before slice 43) are reworded for Google
  Cloud.

## Tests

- **Terraform 1.16.5** (the CI version), with mocked providers and no Google Cloud credentials:
  - `terraform fmt -check` passes.
  - `terraform validate` passes for `harbour_stack` and `envs/{dev,staging,prod}`.
  - `terraform test` passes all 20 runs (16 existing, 4 new):
    - `elearning_origin`: host, the 404 rule's exact expression, the headers, and listed records;
    - `elearning_dns_in_this_project`: records managed in Cloud DNS;
    - `elearning_off_by_default`;
    - `elearning_under_the_app_domain_is_refused`.
- **App**: `pnpm lint` and `pnpm typecheck` pass. The API, domain and web tests pass; the results are
  in the report to the lead.
