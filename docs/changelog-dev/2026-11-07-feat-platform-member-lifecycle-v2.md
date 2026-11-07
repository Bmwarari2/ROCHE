# Member lifecycle completed on change_membership (H-566 v2)

Branch `feat/platform-member-lifecycle-v2`, from `integration/phase-2-batch-3b`. Ports what was new
in `feat/platform-member-lifecycle` onto migration 0129's design: no second function or trigger
changes a member's status; `app.change_membership` and `tenant_user_membership_guard` are reused.

## What changed

- **Migration 0153**: `status_changed_at`, `sign_in_erasure_requested_at`, `sign_in_erased_at` on
  `tenant_user`, set by `app.change_membership` (replaced in place as `harbour_member_owner`) and
  `app.request_sign_in_erasure` (own row); the application role cannot write them.
  `app.change_membership` may now, as the system, remove the link of an ended membership whose
  sign-in is due; `app.sign_ins_due_for_erasure` lists them for the worker.
- **API**: `POST /v1/members/{id}/reinstate` (only what the manager holds), `GET .../lifecycle`;
  suspension counts the member's own held entries only; ending waits for held entries and a
  coded device check; the nightly sweep erases due sign-ins and closes the deletion request.
- **Web**: the member page shows the membership, sign-in, deletion request, devices and held
  entries, with suspend, reinstate, end and erase sheets; two seeded members for the journey.
- **Docs**: platform.md, data standards, records of processing, HZ-110 rows (provisional, pending
  CSO review at the testing phase), H-566 status, H-1461 to H-1468.

## Review fixes and H-1469

- Security: the system unlink only on the worker's own connection, under the sign-in's lock,
  which invitation acceptance and single sign-on linking now take too; unlink and identity
  deletion in one transaction; a failed run audited; the sweep its own job; only closed
  organisations ignored; whether someone works elsewhere shown only once ended; the reinstate
  permission check read under the lock.
- Accessibility: truthful suspend and end copy, the sign-in line for an ended member, keep labels.
- H-1469 (lead, for the Thapsus-HR link rule 8): a holder of `platform.user.manage` across the
  organisation reinstates an ended membership whose sign-in is intact and whose member has not
  asked for deletion, through `app.change_membership` and the guard (replaced in place); HZ-133
  row.

## Left

- H-1465 to H-1467 for the CSO; a lost-device hold closure was not built (not a simple action).
