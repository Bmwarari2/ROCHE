# Policy library and read-and-sign (Phase 2 slice 25)

Branch `feat/quality-policy-library`. Register row QUAL-008 (schema and API; screens come with
slice 65).

## What changed

- Spec: [quality.md](../specs/quality.md) section 18 (schema, permissions, rules as built, API,
  clinical safety, tests and what is left for later).
- Hazard log: HZ-128 (staff follow a superseded policy or procedure) added with its controls and
  `hazard HZ-128 ...` tests.
- Database: migration 0087 (`policy`, `policy_version`, `policy_signature`) with forced row-level
  security. Every member reads policies and the versions published; holders of
  `quality.policy.manage` write them and read drafts. One draft and at most one published version
  per policy; publishing, in the publisher's own name and never by the author where the policy
  needs a second reviewer, supersedes the last version in the same transaction; a published
  version is fixed but for its state; signatures are append-only, in one's own name, only on the
  version in force. A policy version's document must be one of the organisation's documents.
- API: the library (version in force only), a policy with its versions and change log (a
  superseded version names the version in force), creating, drafting (minor or major), changing a
  draft, publishing with the slice 8 publication checks, retiring with a reason, signing, the
  read-and-sign status for managers and `/v1/me/policies`. Outbox `quality.policy.published`.
  OpenAPI and the client regenerated.
- Reminders and review: the `policy-reminders` job (hourly) assigns a read-and-sign task to each
  outstanding member every `policy.read_and_sign.reminder_days`, completed by signing and cancelled
  by a newer version or retirement, and one review task per review state for the author (or the
  publisher when the author has left).
- Data protection: records of processing, data standards, retention, the export catalogue, the
  feature register row.
- `apps/api/src/services/system-rights.ts` is the same file as on `feat/work-training-competence`
  (slice 17), so the two branches merge cleanly.

## What is next

- Slice 65: the policy screens with the state and version on every page and print, vendor PDF and
  structured import, the starter templates (H-743) and the change log view.

## Human actions logged

- H-740 (CSO rates HZ-128), H-741 (second reviewer defaults), H-742 (retention of read-and-sign
  records), H-743 (starter templates).

## Tests

- `packages/db/test/policies.test.ts`: 14 tests (HZ-011, HZ-128).
- `apps/api/test/policies.test.ts`: 12 tests (HZ-128).
- `route-gates.test.ts` lists the four routes every member may use; `sample-data.test.ts` lets a
  policy version stop removal of a sample document it uses.
