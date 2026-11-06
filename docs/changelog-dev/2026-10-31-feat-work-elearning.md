# E-learning runtime

Branch `feat/work-elearning` (Phase 2 slice 43; WORK-006; ADR-0093; migration 0112).

## What changed

- Migration 0112: `elearning_course`, `elearning_attempt`, `elearning_statement`, with forced RLS.
  Courses are read by staff and written by training leads. Attempts and statements belong to the
  member, and training leads can read them. Only the system links a completion's training record,
  a completion is never taken back, statements are append-only, and nothing is deleted.
- Packages (SCORM 1.2, SCORM 2004, xAPI; up to 100 MB):
  - The zip is read from its central directory, and every entry is refused if it leaves the
    package, is a link, is encrypted, is of a disallowed type, or would unpack too far. This
    happens before anything is inflated.
  - Entries inflate only to their declared size, and their CRC must match.
  - Manifests are parsed with entities off.
  - The package is scanned for malware and kept as an `elearning_package` document, never through
    the general document routes.
  - fast-xml-parser 5.11.2 (MIT) was added to the API.
- Attempts:
  - Starting or resuming an attempt gives a signed, short-lived launch token. With that token, the
    sessionless `/e/launch/{token}` routes serve only that course's files and keep only that
    attempt's xAPI statements.
  - SCORM commits are read through an allowlist.
  - A completion or pass becomes a training record, once.
- Web:
  - The content origin (`ELEARNING_ORIGIN`, another site; 127.0.0.1 locally) serves only
    `/learn/{token}`. It hosts Harbour's runtime page with the SCORM 1.2 and 2004 APIs, which talks
    to the app only by the `harbour.elearning.v1` postMessage protocol, checked on both sides.
  - No app page is answered on the content host, and only the player may frame the content origin.
  - Course list, player, and upload for training leads.
- Infra:
  - `learn.<domain>` gets its own CloudFront distribution (no X-Frame-Options, no referrer). The
    CloudFront module's frame, referrer and permissions headers are now variables.
  - The web task gets `ELEARNING_ORIGIN`.
  - The API task gets `ELEARNING_LAUNCH_SECRET`, which seed-secrets.sh now generates.
- The generated client passed Biome's 1 MiB file limit; I copied main's fix (`biome.json` and the
  `generate:client` script).
- Docs: ADR-0093, workforce.md section 14, records of processing, data standards, retention
  mapping, a follow-up under HZ-124, feature register (WORK-006 done), human actions H-1010 to
  H-1019.

## Security review fixes

The security reviewer found 2 High, 8 Medium and 7 Low issues. Fixed here:

- **H1**: the content origin must be another registrable domain from the app's. `contentOrigin`
  refuses one on the app's own site, and Terraform takes `elearning_domain_name`, with its own
  certificate, distribution and DNS, and a check that it is not under `domain_name`.
- **H2**: no whole archive in memory. The course keeps an index made at upload, when every file is
  inflated and checked once. Each file is served by a ranged read of its own bytes (new
  `getRange` on document storage), inflated as a stream with a size and CRC check, at most 16 at
  once an instance, throttled per attempt. The package cache is gone.
- **M1**: a fail is final for that attempt (domain rule and trigger).
- **M2**: completions are audited in the completion's own transaction, session or token alike.
- **M3**: the zip reader refuses parser differentials: local headers must match central entries,
  entries must tile the file, the end record must be last, no ZIP64 locator.
- **M4**: the proxy checks the content host on every path, route handlers and prefetches
  included; the load balancer forwards only `/learn/*` on that host.
- **M6**: tokens carry the attempt's launch nonce, replaced at every launch; retired courses are
  not served; the default lifetime is now 120 minutes.
- **M7**: statements capped at 5,000 an attempt; commits that change nothing write nothing; the
  runtime sends commits at most every 5 seconds; commits and statements are throttled.
- **M8**: the package is told the member's first name only.
- **L1** (the package must be an e-learning document, available, checked in code and by a
  trigger), **L2** (the database statement check is a backstop above the API limit, and its
  refusals are a 400), **L3** (manifest nesting capped; anything unexpected is a refusal),
  **L4** (no fullscreen for content), **L5** (commit bodies capped at 128 KB), **L6** (names with
  controls, separators, bidirectional overrides or not NFC are refused).
- Two suite failures were fixed: the route-gates test lists the token routes, and the sample-data
  removal list names `elearning_course` as stopping removal.

## Found, not fixed here

- Left open for decision in H-1017: renaming the session cookie `__Host-` (H1); one content
  origin per organisation or per launch (M5); exchanging the launch token for a cookie so it
  leaves access logs (M6). L7 (restrictive policies on `harbour_app` only) repeats migration
  0079's pattern; both should change together.

- A completion is reported by content in the member's browser, as in any SCORM LMS. Whether it
  should need a training lead's confirmation is H-1013.
- xAPI state, SCORM interactions and offline courses on the phone (slice 72) are not built; see
  workforce.md section 14.7.
- Next.js keeps the CSP of the first document across client navigations, so the course links use
  full page loads. Any later page that frames something must do the same.
