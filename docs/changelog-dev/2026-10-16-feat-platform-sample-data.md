# Sample data mode for people (PLAT-018)

Branch `feat/platform-sample-data`, PR #98. Migration 0069, after #95 (0067) and #97 (0068).

## What changed

- Migration 0069 adds `sample_batch` (forced RLS; loaded only by a holder of
  `platform.onboarding.manage` in their own name; one batch not removed per organisation) and
  `person.is_sample` and `person.sample_batch_id`, which must be set together.
- The `person_sample_guard` trigger runs as the new NOLOGIN role `harbour_sample_owner`, so every
  role that writes people is guarded the same way. It refuses sample people beside real ones and
  real people beside sample ones (rule 30), and it refuses any change between the two. It takes a
  per-organisation lock so that a load and an admission cannot pass each other.
- `app.remove_sample_batch` removes a whole batch or nothing (rule 32). It checks the permission
  and legal holds, and refuses if another record still refers to a person in the batch. It then
  records the removal on the batch and audits it with counts only. `harbour_app` has no DELETE.
  `app.sample_people` counts the whole organisation for the checklist. Both are listed in the
  definer ACL test.
- `POST` and `DELETE /v1/onboarding/sample-data` load the four invented people from
  `SAMPLE_PEOPLE` at the first location, and remove them. They are audited, refusals too, with
  409 and the domain's plain-English reason (`sampleDataRefusal`).
- The onboarding checklist's "sample data removed" item now reads the records. The data opt-out
  count leaves sample people out, and the full export leaves them out and counts them.

## What is next

- The web side: the badge, the banner and the load and remove controls.
- Flags on records about sample people. Until then, any such record blocks removal, and so does a
  released legal hold.
- Sample treatment on the other surfaces, such as the downtime pack and notifications.

## Review round 1

- Blocking fix: an organisation can no longer get stuck with sample data. `app.remove_sample_batch`
  now hard deletes what staff recorded about the sample people while practising, from an
  allow-list of tables about a person, children before parents. The allow-list was worked out from
  the foreign keys, and every row is limited to the organisation and the batch's people. The
  append-only triggers allow a delete only inside that function (`harbour_sample_owner` plus the
  transaction's mark), never for `audit_event` or `record_version`. A released legal hold goes too;
  an active one stops the removal with plain words. A record outside the list that still refers to
  the people (an outage, a downtime pack, an escalation policy link) stops it as
  `referenced_by_other_records`, which no longer calls practice records "real". The audit scope
  counts per table.
- `app.sample_people()` now says only yes or no: whether a batch is still in place (keyed on the
  batch, so soft-deleting a sample person changes nothing) and whether any real person exists
  (soft-deleted ones too). The guard refuses to run under REPEATABLE READ, because its advisory
  lock relies on a fresh snapshot after the lock.
- Removal needs a fresh step-up. The people streams carry `is_sample` for the badge.
- Open: a removed sample person's stored document files stay in the bucket.
