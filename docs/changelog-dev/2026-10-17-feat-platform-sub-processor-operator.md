# Sub-processor notices, Thapsus's side (PLAT-023, rules 24 and 25)

Branch `feat/platform-sub-processor-operator`, PR #95.

## What changed

- An admin with a fresh step-up announces a notice. The organisations it affects come from their
  configuration (never people): every organisation not closed, suspended ones included. The
  effective date respects the longest of their notice periods (`checkNoticeTiming`, 422
  `notice_too_short`).
- Migration 0067: announcing, reading objections and resolving one go only through definer
  functions owned by the new NOLOGIN role `harbour_notice_resolver` (bootstrap adds it). They take
  the admin from the transaction's `app.operator_id`, need an open objection to resolve, and write
  each organisation's audit event and an outbox event in one transaction; the worker tells the lead
  (or owners) with a dedupe key, retrying until it has. The operator role has no direct access to
  notices or responses, and the other application roles cannot execute the functions.
- Docs: platform-completions.md section 10h, feature register, STATUS.

## What is next

- Merge main again once #91 lands, chaining 0067's snapshot to 0066.
- The web screens for sub-processors; sample data mode.

## Human actions logged

- None. Deployments run `pnpm db:bootstrap` before migrating, as for every new NOLOGIN role.

## Tests

- `apps/api/test/operator-sub-processors.test.ts` (4): announcing (refusals, step-up, timing, a
  suspended organisation, telling once however often delivered), an unused sub-processor affecting
  no one, reading and resolving objections (support and stale step-up refused, 409s, 404), and the
  operator and application roles' access. API 1,124 and db 562 pass.

## Review rounds

- Round 1: suspended organisations included; per-organisation work made durable through the
  outbox; the caller from `app.operator_id`; execute rights set before the owner change (PUBLIC
  could run the functions before); no `record_version` grant; more tests. Renumbered to 0067 for
  #91's 0066.
