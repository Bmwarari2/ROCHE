# Recommended answers applied to staff privacy, sponsor records and family photos

Branch `feat/web-staff-file`. An owner instruction gave every open human question a recommended
answer, reviewed at testing. Four change what slices 35 and 56 built; each row in
`docs/plans/human-actions.md` now reads "recommended answer applied 31/10/2026 (review at testing)".

## What changed

- **H-901, sponsor records.** A new `sponsor_record` retention row (2 years from record closed:
  a year after sponsorship ends, never less than the right to work copies' 2 years after
  employment ends) for `sponsored_worker`, `sponsor_absence` and `sponsor_report`, in
  retention.md, the export catalogue (`ExportRetention`) and records of processing. Tests: the
  retention row parses and is never shorter than `right_to_work_copy`; the catalogue uses it.
- **H-905, staff in family photos.** Publishing a feed photo names the staff shown
  (`staffShown`, at most 20, kept on `feed_item.staff_shown`, migration 0106). Each must have said
  yes to `family_feed` in My privacy, read in the system's view; otherwise it is refused and
  audited as `staff_not_consented`, naming no one. The family updates form lists current staff
  (the staff picker now also answers `comms.feed.publish`). The image consent wording says, for
  each use, what is shown and where, that saying no has no effect on the job, and that the answer
  can be changed in My privacy. Tests: API (never asked, refused, consent to another use, given,
  withdrawn, no staff named), web lib (fields, de-duplication, the limit), wording.
- **H-907, English language evidence.** `uk_school_qualification` and
  `professional_body_assessment` added to the check constraint (migration 0106), the contract, the
  web choices, the copy, data-standards.md and the export catalogue. Tests: API accepts both and
  refuses an unknown code; web choices match the contract.
- **H-940, the staff privacy notice.** The notice in force is an available organisation document
  of the organisation (`tenant.staff_privacy_notice_document_id`, composite foreign key and a
  trigger, migration 0106); the label members acknowledge is the document's id, so each new
  version is asked about afresh. `PUT /v1/workforce/staff-privacy-notice` takes `documentId`
  (422 and audited for anything else); `GET /v1/me/staff-privacy` returns the notice's title and
  version. The data protection page chooses from the organisation's documents; My privacy names
  the notice by title and version and links to it. Tests: API, database trigger, web lib, e2e.

## Found, not fixed here

- Taking down feed photos already published when a member withdraws `family_feed` consent is
  still a manager's task ("ask your manager"); `feed_item.staff_shown` now makes those photos
  findable.
