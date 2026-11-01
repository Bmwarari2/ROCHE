# Whistleblowing and speaking up (SAFE-012, Phase 2 slice 24)

Branch `feat/safety-speak-up`, stacked on `feat/safety-complaints`. ADR-0089 records the silo.

## What changed

- Domain:
  - `safety.speak_up.manage` is the Freedom to Speak Up lead's silo permission (`SILO_PERMISSIONS`).
    Built-in roles made from "every permission" leave it out; only the new built-in
    `speak_up_guardian` role carries it. `SPEAK_UP_WORKFLOW` uses only it.
  - The records of processing gain B16 (whistleblowing and speaking up) and the `speak_up` data
    category, so the in-app register and the DPIA prefill list it.
- Database, migration 0086 (one self-contained file):
  - `speak_up_concern`, `speak_up_reporter`, `speak_up_case_member` and `speak_up_message`, with
    forced RLS. They are open only to the lead, the members the lead names on the case, and whoever
    raised a named or confidential concern. A public request carrying a reply token's hash opens
    that one anonymous concern.
  - A concern never stores its creator. A member can claim a concern only in the transaction that
    made it. Messages and reporters are append-only, and the application has no DELETE.
  - The silo tables keep no copies in `record_version`, which every member reads. They do not use
    the shared workflow or outbox tables, and they are left out of the free full export.
  - Guards refuse a role mixing a silo permission with any other, an access grant carrying one,
    self-appointment, and the silo held with user or role management.
- API (`apps/api/src/routes/speak-up.ts`):
  - `/p/speak-up/{tenantId}` raises an anonymous concern with no sign-in. It records no session,
    device, IP address or identity. The reply token is 256 random bits, shown once, stored as a
    SHA-256 and sent only in bodies. `.../thread` and `.../messages` read and reply with it.
    Requests are limited in Postgres (see the security review fixes below).
  - `/v1/speak-up` raises a named or confidential concern, and `/v1/speak-up/mine` follows it.
  - `/v1/speak-up/cases` serves the lead and the case's members: list, read, message, step and
    members.
  - Raises, reporters' replies and anonymous reads are audited with no actor, IP address, device or
    request id. No outbox event is published. OpenAPI and the client are regenerated.
- `generate:client` now formats the client through Biome's standard input, because the generated
  file passed Biome's 1 MiB file limit.
- Docs: `safety.md` (permissions and API), `data-standards.md`, `records-of-processing.md` (B16, a
  new category and a note), the feature register (SAFE-012 partial), and human actions H-720 to
  H-722.

## Tests

- `packages/db/test/speak-up.test.ts`:
  - The owner, the Registered Manager, the quality lead and another organisation read nothing.
  - The lead, the reporter and named members see what they should, and tokens work only by their
    hash.
  - The claim and creator rules hold, and nothing reaches `record_version`.
  - The role, grant and appointment guards refuse what they should.
- `apps/api/test/speak-up.test.ts`:
  - Nothing identifying an anonymous reporter reaches the concern, audit or outbox, including the
    client address and device header.
  - The token is stored only hashed.
  - The steps and the outcome rules work, the reporter sees no member's name, and the throttle
    applies.
  - The owner and the Registered Manager see nothing and cannot step.
- `whistleblowing.test.ts` (silo permission), `route-gates.test.ts`,
  `processing-register.test.ts` and `dpia.test.ts` are updated.

## Not done

- Web and mobile screens.
- A whistleblowing retention class and the lead's separate export (H-721).
- No hazard row: the plan names none for slice 24.

## Security review fixes

- H1:
  - Public requests are counted in Postgres (`speak_up_intake`), shared by every instance and
    deploy.
  - The buckets are per network (an IPv6 /64 or IPv4 address as an HMAC keyed by
    `SPEAK_UP_THROTTLE_SECRET` and the UK date; L6), per organisation per minute, and anonymous
    concerns per organisation per UK day (`SPEAK_UP_REQUESTS_PER_MINUTE_PER_NETWORK` 10,
    `SPEAK_UP_REQUESTS_PER_MINUTE_PER_TENANT` 60, `SPEAK_UP_ANONYMOUS_PER_DAY` 50).
  - The lead's list pages by cursor and shows "possible flood" past the daily limit.
  - The worker sweeps passed windows hourly.
- M2: `/p/speak-up/*` takes bodies up to 48 KiB. Tests cover the longest concern (accepted) and a
  body past the cap (413).
- M3: audit events about a concern are read only by the lead (`audit_speak_up_silo`), including
  in `/v1/audit` and the export. `app.verify_audit_chain` runs as the new `harbour_silo_owner`
  role, so the chain still verifies for everyone.
- M4: editing a role someone holds is checked like appointing them. The silo guards run as
  definer, so a caller's scope cannot hide an assignment.
- L5: `app.set_speak_up_lead` and `PUT /v1/speak-up/lead` let a member who manages users appoint or
  remove the lead. Each change is audited.
- L7:
  - `app.raise_speak_up` is the only writer of reporters, so the `age(xmin)` checks are gone.
  - The silo's policies bind `harbour_owner`.
  - `DSAR_NOT_SEARCHED` lists the silo as "not searched: restricted silo".
  - Reply tokens expire (`speak_up.reply_token_days`, 180, to verify), and the response gives the
    last date.
- Human action H-723: add `speak_up_throttle_secret` to each environment's `api` secret before
  deploying. The new role needs `pnpm db:bootstrap` before `pnpm db:migrate`.

