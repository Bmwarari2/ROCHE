---
status: "accepted"
date: 2026-10-31
decision-makers: Harbour engineering (Phase 2 lane B)
consulted: Security reviewer; data protection lead (H-1015)
informed: Workforce and mobile (slice 72) builders
---

# E-learning runtime: SCORM and xAPI on a separate content origin

## Context and problem statement

Master prompt sections 12.2 and 15.3 ask for a SCORM and xAPI player, with completions counting
as training (WORK-006). An e-learning package is a zip of HTML, script and media written by a
third party: it is untrusted code. It must run where it can never reach the app's origin, its
session cookie or a member's care records, and its archive must not be a way to write outside a
folder or exhaust memory. [phase-2.md](../plans/phase-2.md) sets this decision for slice 43:
"an allowlisted SCORM 1.2 and 2004 runtime in a sandboxed iframe on a separate origin; xAPI
statements kept in Harbour (no external learning record store); no course content shipped".

## Decision drivers

- Untrusted content never runs on the app origin, and cannot read its cookies, DOM or storage.
- The runtime reaches the app only through a narrow, validated message protocol.
- Archives are checked before anything is unpacked: no path traversal, links, encryption or bombs.
- Completions become slice 17 training records without letting a member write their own.
- No new third-party service receives personal data; libraries only from the licence allowlist.

## Considered options

- A separate content origin served by Harbour's web tier, Harbour's own SCORM runtime page
  there, postMessage to the app.
- Package content served from the app origin in a sandboxed iframe without `allow-same-origin`.
- An external LMS or learning record store (SCORM Cloud or similar).

## Decision outcome

Chosen option: "a separate content origin served by Harbour's web tier", because it is the only
option that keeps untrusted script off the app's site while letting packages find the SCORM API
as the standards require, with no new sub-processor.

- **Origins.** `ELEARNING_ORIGIN` (production `https://learn.<elearning_domain_name>`, a
  registrable domain of its own with its own Certificate Manager certificate and its own backend on
  the Google Cloud load balancer, ADR-0098; development
  `http://127.0.0.1:3000`, the same server under another host name) is another site from the app:
  `contentOrigin` refuses an origin on the app's own registrable domain, because a subdomain of
  it would be the same site, able to set cookies the app receives and to count as same-site
  (security review H1). The load balancer forwards only `/learn/*` on the content host (a path
  matcher on that host, to the web tier) and Cloud Armor answers anything else there with a fixed
  404 before any backend; the web proxy also refuses every other path there,
  route handlers and prefetches included (M4); the app origin never serves `/learn`. No cookie of
  the app is ever sent to the content host.
- **Framing.** The app's course player alone may frame the content origin (`frame-src` on that
  page only). The runtime page's policy allows only its own script and a child frame on its own
  origin, and `frame-ancestors` names the app. Package files may run inline script and eval (SCORM
  content needs them), but only on the content origin, framed only by the runtime page and the
  app, with `connect-src 'self'` (only that token's own files and statements are served) and no
  plugins or workers. The player's iframe is sandboxed (`allow-scripts allow-same-origin
  allow-forms`): same-origin is the content origin's own, never the app's.
- **Launch tokens.** Starting or resuming an attempt returns an HMAC-signed token
  (`ELEARNING_LAUNCH_SECRET`, from the managed store) naming one attempt, its member, course,
  organisation and the attempt's current launch nonce, expiring after `ELEARNING_LAUNCH_MINUTES`
  (120 by default). Each start or resume replaces the nonce, so only the latest token works, and
  a retired course is served to no token (security review M6). The sessionless API
  routes `/e/launch/{token}/files/{path}` and `/e/launch/{token}/statements` accept nothing else:
  they read the attempt as its own member (who must still hold a staff role), serve only that
  course's own files of allowlisted types, and keep only that attempt's statements. Each file is
  served by a ranged read of just its own bytes from the stored archive (the course keeps an
  index made at upload), inflated as a stream and checked against its size and CRC, with at most
  16 files streaming at once an instance and calls throttled per attempt; nothing holds a whole
  archive in memory (H2). An attempt keeps at most 5,000 statements (M7).
- **Runtime and protocol.** Harbour's runtime page offers `window.API` (SCORM 1.2) and
  `window.API_1484_11` (SCORM 2004) to the package framed below it, keeps the data model in
  memory, and sends the app only the elements Harbour keeps (`CMI_ELEMENTS`) on commit or finish.
  Messages use `harbour.elearning.v1` (`ElearningRuntimeMessage`, `ElearningAppMessage` in
  `@harbour/contracts`): each side checks the sender's origin against configuration, the source
  window (its own parent or its own frame), the shape with the shared schema and the attempt id,
  and drops anything else. The app saves commits through the API, which checks the allowlist and
  lengths again.
- **xAPI.** xAPI content is launched with an endpoint on the content origin for that token only
  and an actor naming the attempt, never the person. Statements (at most 50 a request, 16 KB
  each) are kept as sent in `elearning_statement`, once per statement id; a completed, passed or
  failed verb settles an xAPI course's attempt. State and activity profile documents are not
  kept (state writes are accepted and dropped), so xAPI content cannot resume.
- **Packages.** Uploaded only through the e-learning route (never the general document routes), at
  most 100 MB. The zip is read from its central directory and must read the same to every reader
  (the end record last, no ZIP64 locator, every local header matching its central entry, the
  entries tiling the file with no overlap or hidden bytes; M3), refusing ZIP64, spanned and
  encrypted archives, non-UTF-8 names that are not ASCII, names with controls, separators,
  bidirectional overrides or not in normal form C (L6), symbolic links, unknown compression, entries
  whose path is absolute, uses a backslash or drive, or has an empty, `.` or `..` segment,
  case-insensitive duplicates, file types outside the allowlist (web pages, scripts, styles,
  images, audio, video, fonts, PDF; no server code, executables or nested archives), more than
  5,000 entries, more than 500 MB unpacked, or any entry unpacking more than 100 times its packed
  size. Every entry is inflated once at upload, up to its declared size, and its CRC must match.
  Manifests
  (`imsmanifest.xml`, `tincan.xml`) are parsed with fast-xml-parser (MIT) with entities off, a
  DOCTYPE refused and nesting capped (L3); the launch page must be an HTML file inside the package. The archive is then
  scanned for malware and kept as an `elearning_package` document; a package that could not be
  scanned is refused. Nothing is unpacked to disk; files are read out of the stored archive.
- **Completions.** A completed or passed attempt becomes a `training_record` (the course's topic
  and tier, provider "Harbour e-learning: <title>"), written once by the organisation's system
  context under a row lock and audited in the same transaction, whether the member's session or a
  launch token reported it (M2); the member cannot write a training record or link one (row-level
  security and a trigger), and a settled outcome is never changed: a fail is final for that
  attempt, and a retake is a new attempt (M1).

### Consequences

- Good, because untrusted content runs on another site, sandboxed, with a narrow protocol; a
  compromised package can at worst report its own attempt's outcome.
- Good, because no learning record store or LMS receives personal data; the package sees the
  member's first name and id only through the SCORM data model in the browser (never the full
  name, M8), and its `connect-src 'self'` keeps them from most routes out (not DNS prefetch or
  WebRTC, which is why the full name is withheld).
- Bad, because a completion is self-reported by content running in the member's browser (as in
  every SCORM LMS): a member with developer tools can mark their own attempt complete. The
  training record says it came from e-learning (its provider), the attempt keeps its history, and
  whether a course's completion should need a training lead's confirmation is an open decision
  (H-1013). It never satisfies a competence sign-off, which is observed (ADR-0085).
- Bad, because a separate registrable domain, its distribution and certificate must be run, and
  `ELEARNING_LAUNCH_SECRET` added to each environment's secret (H-1010, H-1011).
- Bad, because the security review left hardening to decide (H-1017): one content origin is
  shared by every organisation and course, so packages on one device share its storage (M5); the
  launch token travels in URL paths that access logs keep (M6); the session cookie is
  `__Secure-` rather than `__Host-` (H1); and the restrictive policies target `harbour_app` only,
  as migration 0079 does (L7).
- Neutral: offline packaging for the mobile app (slice 72) is not built; the stored archive and
  the allowlisted file list are what it would need (H-1018).

### Confirmation

- `packages/domain/src/workforce/elearning.test.ts`: entry names, archive limits, file types,
  launch paths, the data model allowlist, outcomes, session times, xAPI verbs.
- `apps/api/test/elearning-package.test.ts`: traversal, links, encryption, bombs, lying sizes and
  CRCs, ZIP64, DOCTYPE, launch pages, tokens (forgery, tampering, expiry).
- `packages/db/test/elearning.test.ts` and `apps/api/test/elearning.test.ts`: isolation, own
  attempts only, system-only completion, statements append-only, the token routes.
- `apps/web/src/lib/elearning.test.ts`, `elearning-runtime.test.ts`: origins, policies, message
  checks, the runtime's API and allowlist.
- `apps/web/e2e/elearning.spec.ts`: a real SCORM package passes through the runtime on the content
  origin to a training record; the content host serves no app page and the app serves no content.

## Pros and cons of the options

### Content served from the app origin, sandboxed without allow-same-origin

- Good, because no third origin is needed.
- Bad, because the package and Harbour's runtime page would be opaque origins: the package cannot
  find the SCORM API in its parent, so SCORM content does not work; a mistake in the sandbox would
  run untrusted script on the app's own origin.

### An external LMS or learning record store

- Good, because a mature runtime and reporting come with it.
- Bad, because a new sub-processor receives staff personal data (a DPIA and register change), data
  may leave the UK, and completions arrive by integration rather than as Harbour records.
