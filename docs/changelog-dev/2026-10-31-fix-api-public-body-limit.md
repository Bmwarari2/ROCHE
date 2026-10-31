# Body caps at the API edge on routes reached with no session

Branch `fix/api-public-body-limit`.

## What changed

- `apps/api/src/app.ts`: a Hono `bodyLimit` on every route reached with no session that takes a
  body, answering 413 with the API's problem shape (`too_large`, "The request is too large.",
  with the request id) before the body is read or anything is written. A declared length over
  the cap is refused at once; a streamed body is counted as it arrives.
  - 4 KiB (`PUBLIC_MAX_BODY_BYTES`, the same as the web's `PUBLIC_BODY_MAX_BYTES`): `/p/*`
    (`/p/evidence/code`, `/p/evidence/verify`, and any later public evidence route),
    `/v1/invitations/lookup` and `/v1/invitations/accept`.
  - 64 KiB (`AUTH_MAX_BODY_BYTES`): `/api/auth/*` (Better Auth: sign-up, sign-in, second
    factors, passkey registration, whose attestation is the largest body at a few kilobytes).
    Registered before the auth handler, which answers without calling on.
  - The other routes with no session are GET only (`/health`, `/openapi.json`,
    `/p/evidence/bundle`, `/v1/sync/jwks`): `@hono/node-server` gives a GET or HEAD request no
    body, so there is nothing to cap (`/p/evidence/bundle` is under the `/p/*` cap anyway, and
    `/v1/sync/*` already has its 64 KiB cap). Every other `/v1` route needs a session.
- Security checklist V4.

## What is next

- None.

## Human actions logged

- None.

## Tests

- `apps/api/test/evidence-link.test.ts`: a code request and a code just over 4 KiB, streamed and
  with a declared length, get 413 with the problem shape; no code is sent, no attempt counted, no
  cookie set and no audit row written; a body exactly at the cap is read and opens the link with
  the same code; a normal body works.
- `apps/api/test/invitations.test.ts`: a lookup and an acceptance just over 4 KiB (both ways) get
  413; the member stays invited, no sign-in is created and nothing is audited; a normal lookup and
  acceptance work.
- `apps/api/test/api.test.ts`: a sign-up just over 64 KiB (both ways) gets 413 and creates no
  user; a normal sign-up works.
- Shared helpers in `apps/api/test/support/body-size.ts` (a JSON body of an exact size; audit rows
  by request id, read as superuser).
