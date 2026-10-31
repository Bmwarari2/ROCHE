# API hardening from the 31 October security reviews (PLAT-007, PLAT-012, PEOPLE rule 7)

Branch `fix/api-hardening`.

## What changed

- Request ids (PLAT-007): the API keeps a caller's `x-request-id` only when it is a UUID or 1 to
  64 letters, digits and hyphens (`apps/api/src/http/request-id.ts`), and otherwise makes a fresh
  UUID before anything runs. Before, any text went into `audit_event.request_id`, which is
  append-only and hash-chained, so a caller could write personal data into the audit chain for good
  and forge log correlation. Only the request-id middleware line in `app.ts` changed (plus its
  import), so the `onError` work on `feat/web-admission` merges cleanly. The web passes on only a
  well-formed id: the server-side API client (`apiRequestHeaders` in `api-headers.ts`, used by
  `api.ts`), the public evidence pages (`callerHeaders`, used by `evidence-link-server.ts`, which
  reached `main` while this branch was open) and the Better Auth proxy (`api-proxy.ts`).
- Property witnesses (people.md rule 7): a witness to an item in, a return or a disposal must be
  an active member of staff with a staff role in force at the person's home and no open family
  portal link (`isStaffAt` in `services/role-holders.ts`). A family portal account, a suspended,
  invited or departed member, someone whose role there has ended, staff at another home, or anyone
  outside the organisation is refused with "The witness must be a member of staff who works at this
  person's home and whose account is active." Before, only the foreign key and "not the recorder"
  were checked.
- Retention destruction (PLAT-012): placing a legal hold and `POST /v1/retention/destroy` take the
  same per-organisation advisory lock; the destruction then locks the requested documents
  `FOR UPDATE` and reads the holds, so under READ COMMITTED a hold committed in between is seen and
  a hold placed meanwhile waits. The tombstones, certificate, audit event and one
  `platform.document.destroyed` outbox event per document commit first; the bytes are deleted
  after the commit, and the worker deletes them again from the outbox event (idempotent, only for a
  document recorded as destroyed) until it succeeds. A failed deletion writes `worker.job.failed`
  (queue `document-destruction`), which the existing operator alarm watches (H-171), and stays an
  unpublished outbox event; the on-call runbook says how to find and retry them. The certificate
  now lists only the documents actually marked destroyed.
- Audit: `GET /v1/legal-holds` is audited (`platform.legal_hold.list`, by count). `GET
  /v1/retention/candidates` was not audited either, so it now is (`platform.retention_candidate.list`).
- Public JSON body cap (item 5 of the review): not changed here. The evidence branch owns it and
  its cap is on `main` (`readJsonBody` in `apps/web/src/lib/json-body.ts`, 4 KiB, used by the
  evidence and invitation handlers; #113 review L1). The API's own public routes
  (`/p/evidence/code`, `/p/evidence/verify`, `/v1/invitations/lookup`, `/v1/invitations/accept`)
  still have no `bodyLimit` at the API edge, as `/v1/sync/*` has: a follow-up for that branch.
- Docs: platform.md (PLAT-007 request ids, PLAT-012 locking, order and detection), people.md (the
  witness rule), the security checklist (V2, V14, V16) and the on-call runbook. No migration. No
  clinical hazard is touched (no HZ covers property witnesses or document destruction), so the
  hazard log is unchanged; no new personal data is processed, so the records of processing and
  data standards are unchanged.

## What is next

- The API's public body caps are on `fix/api-public-body-limit` (its own pull request).
- Follow-up (L5 below): read a witness's family portal link through a security-definer function
  returning a boolean, so a link to someone outside the caller's scope is seen too. It needs a
  migration, and migrations are held at 0071 until #123 merges.

## Human actions logged

- H-341 (product decision): property witnesses now need `people.property.manage` at the home, so
  care workers cannot witness; the owner confirms or relaxes it.

## Tests

- `apps/api/src/http/request-id.test.ts` (16), `apps/api/test/api.test.ts` "request ids in the
  audit trail" (4), `apps/web/src/lib/request-id.test.ts` (10), `apps/web/src/lib/api-headers.test.ts`
  (6, the API client and the evidence pages) and three new cases in
  `apps/web/src/lib/api-proxy.test.ts`.
- `apps/api/test/people-lifecycle.test.ts` "a witness must be working staff at the person's home"
  (9 cases: eight refusals at item in, then return and disposal refusals and a colleague accepted).
- `apps/api/test/documents.test.ts`: bytes gone and the retry queued after a destruction; the
  holds and candidates reads audited; a hold committed while the destruction waits on the lock is
  seen (and the test fails without the lock), and a hold waits for a destruction; a storage failure
  keeps the certificate and tombstone, is logged as `worker.job.failed` and retried until deleted.
- Run after rebasing on `main`: API and web typecheck, `pnpm lint`, the API files
  `people-lifecycle`, `api`, `documents`, `exports`, `downtime`, `operator-sub-processors`,
  `sample-data`, `evidence-link`, `invitations` and `request-id` (360 passing), and the web unit
  tests (1062 passing).

## Review rounds

- Merge of `main` after #114 (documents, tasks and retention screens): an ordinary merge commit.
  The candidates read keeps #114's title rule and audited ids; the destruction keeps the
  retention lock, the certificate before the bytes and the post-commit deletion, and uses #114's
  `certificateItem`. #114 adds no other destroy path (its screens call the same route).
- Security review of #134:
  - M1: a hold now covers a document through any version of it, its own `legal_hold` flag, its
    person, or the record it belongs to (`isDocumentUnderLegalHold` in
    `packages/domain/src/platform/retention.ts`, judged over the whole version chain read through
    `previous_version_id`). Table-driven domain tests, and API tests for each gap that fail with
    the old check.
  - M2: `S3DocumentStorage.destroy` throws `StorageDeleteFailed` when the batch delete reports any
    per-object error, and lists the versions again afterwards, throwing if any remain; so the
    outbox event stays unpublished and alarmed until the bytes are gone. Tested with a double of
    the S3 client (`apps/api/src/integrations/storage.test.ts`).
  - M3: a property witness must hold `people.property.manage` through a staff role in force at the
    person's home (`mayWitnessAt`, replacing `isStaffAt`). Care workers, visiting professionals
    and inspectors are refused, and so is anyone holding a portal role. Note for the product: a
    care worker can no longer witness; a team leader, nurse or manager can.
  - M4: every audit row gets a UUID the API makes, whatever the caller sent; a caller's
    `x-request-id` is only logged beside it (one `caller request id` line) and only when it is a
    canonical lower-case UUID, which is all the web forwards. platform.md corrected.
  - L5: not done here (it needs a migration, held at 0071 until #123 merges); logged above. Partly
    covered meanwhile: a witness holding any portal role is refused, which row-level security
    does not hide, so the gap left is an open link with no portal role, to someone outside the
    caller's scope.
  - L6: the worker (and the route's post-commit attempt) make the key with
    `documentStorageKey(tenant, document id)`; a test changes `storage_key` to another live
    document's and checks only the destroyed document's bytes go.
- Re-check of #134 at 3bb849b6 (M1, M2, M4 and L6 hold; M3 holds on security), after merging
  `main` again (#119, #130, #133, #136, #141; no conflicts):
  - L1: a witness's acting-up grants count. `mayWitnessAt` (now `apps/api/src/services/witness.ts`)
    reads the member's roles and unrevoked grants through `placesHoldingPermission`, as
    `submitHolders` does. Tests: a care worker acting up there is accepted; one whose grant was
    revoked, or who acts up at another home, is refused.
  - L2: the role is judged when the witness witnessed (the acknowledgement's or the recipient's
    `signedAt`, or the end of the UK day of a disposal, never later than now), and the account must
    be active now. Tests: a team leader since an hour ago is refused for an item signed for
    yesterday and accepted for one signed now; one whose role ended an hour ago is the reverse; a
    suspended member is refused either way.
  - L3: a document whose chain cannot be read back to its first version counts as held
    (`documentHeld`). Test: `previous_version_id` pointed at a missing version takes the document
    off the candidates, skips it at destruction and shows it as held.
  - L4: the document view's `legalHold` uses the same judgement as destruction. Test: a later
    version of a held document, and a flagged document, show as held; an unheld one does not.
  - H-341 logged for the witness rule, and people.md says so.
