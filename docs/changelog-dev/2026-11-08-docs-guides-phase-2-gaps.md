# User guides: Phase 2 gaps

Branch `docs/guides-phase-2-gaps`, from `main` at ea6fc04d. Checked against `main` after
daa038a7: #187 (the paper register is the record until controlled drug recording is turned on,
H-1517), #191 (an absconding incident opens a missing person episode, HZ-127), #190 and #199
(documentation only). #184 (the Training tab, H-1365) and #186 (one lone-working section in the
scheduling spec) merged just before daa038a7, after the workforce guides were cut. A batch of
Phase 1 web screens merged on 31/10 after the Phase 1 guides were written; this pass covers them
too.

## What changed

- **24 new guides**, each for a screen on `main`:
  - Platform: set your organisation's branding (PLAT-002); read and sign an organisation document,
    and add one or a new version (PLAT-009); work through your tasks, create a task, and work
    through approvals (PLAT-011); place or release a legal hold, and destroy documents past their
    retention period (PLAT-012); suspend, reinstate or end a membership (PLAT-004).
  - People: change a person's details and contacts (PEOP-001, PEOP-002); write About me
    (PEOP-003); record an enquiry, fill in a pre-admission assessment, record a decision to admit
    (PEOP-005); record an admission and a room, record property and keys (PEOP-007); discharge or
    transfer a person (PEOP-010); record a sharing decision, with share links (PEOP-013).
  - Safety: keep a duty of candour record (SAFE-007); record an incident investigation, read
    incident trends (SAFE-010).
  - Quality and insights: compose and release an evidence pack (QUAL-003); update the statement of
    purpose (QUAL-009); read your home page (INSI-001).
- **Rewritten**: `inspector/open-an-evidence-pack.md` now gives the steps on the evidence pack page
  (`/evidence`), which exists on `main`.
- **Brought up to `main`**:
  - Missing persons (#191): `record-a-missing-person.md` and `keep-a-missing-person-timeline.md`
    say **Missing person** or **Left without agreement** opens the episode, and that the button
    ("Record the missing person episode for" and the name) shows only for the resident recorded as
    the person affected, on an open incident. #191 had already replaced the interim wording.
  - Phone training (#184): both training guides start from the **Training** tab beside
    **Shifts**, with the Settings link as a second way in.
  - Controlled drugs (#187): the five register guides start with the banner's own words
    ("Controlled drug recording is not turned on for this home") and say the forms are not offered
    and the paper register is the record; the print guide quotes both print footers; the browser
    round guide quotes both round notices; the stock, disposal and order guides say which register
    holds controlled drug stock.
  - `review-and-close-an-incident.md`: the candour record and investigations are on the incident;
    `invite-a-team-member.md`: suspending and ending a membership are on screen;
    `check-the-person-before-you-act.md`, `publish-a-family-update.md` and
    `link-to-the-hr-platform.md`: no longer say personal details, sharing decisions or the staff
    file have no screen.
- Role indexes (a new "From the nurse guides" section for the owner), the guides README table and
  its "no guide yet" paragraphs, and the register's user docs column (17 rows) link every guide. No
  status changed.

## Gaps closed

- Phase 1: PLAT-002, PLAT-009, PLAT-011, PEOP-003, PEOP-005, PEOP-007, PEOP-013, SAFE-007,
  SAFE-010, QUAL-003 (the home's screens and the inspector's page), QUAL-009, INSI-001; discharge
  and transfer (PEOP-010); changing personal details (PEOP-002); records retention and legal hold
  (PLAT-012); suspending and ending a membership (PLAT-004).
- Phase 2: an absconding incident opening the episode (SAFE-015); training on its own phone tab
  (MOB-007); the controlled drugs pages saying which register is the record (MEDS-005, MEDS-014).

## Gaps still open

- Phase 1, no screen: recording consent, capacity, best interests and DoLS on the web (CARE-021,
  CARE-022 stay read only); changing a member's role and acting-up grants; changing allergies or
  the photo; INTG-011 channel settings; the share link's recipient page (it "comes with the family
  portal"); turning controlled drug recording on (only Thapsus operators set the flag until H-1518).
- Phone Care mode (MOB-002, MOB-005, MOB-006, MOB-009, MOB-010): the screens exist (notes, charts,
  body map, round, handover, people) but their guides are not written in this pass.
- Unchanged since their changelogs, checked on `main`: the workforce and scheduling list (WORK-007
  LDSS claims, the talent pool, equality answers, employment history, DBS risk assessment, HR-only
  documents, a worker's own training record, LMS import, a nurse's own revalidation evidence, TUPE
  import; SCHED-008 payroll export, SCHED-009 agencies, swaps and open shifts, sickness and family
  leave, mileage and corrections; NFC or location evidence, the offline check-in reminder and lock
  screen help on the phone); the medicines list (MEDS-006 self-administration, MEDS-004 covert
  records, MEDS-003 protocol text and outcome checks, MEDS-013 override approval, MEDS-002 web
  corrections and giving a controlled drug, and the phone items; the 7 phone guides still wait on
  `docs/guides-medicines-phone`); the safety, quality and platform list (INTG-006, INTG-007,
  INTG-013, single sign-on settings, importing contacts and allergies, the Freedom to Speak Up lead
  and speak-up export, IPC audits, staff on the outbreak line list, correcting a death step, the
  Herbert Protocol photograph, a second disclosure pack fetch, refusing a request before it is
  ready).

## Found on screen (for the builders)

- Controlled drugs: the register PDF prints the eMAR's notice ("This is not the live record: check
  the eMAR …") and never says which register is the record, while the browser print view does.
- Controlled drugs: once recording is turned on, the round notice (`medicines.round.cdNoticeTurnedOn`)
  tells staff to record a controlled drug "in the controlled drugs register on this person's
  record", but the web register offers no "Given" movement, so a dose given cannot be recorded
  there. Both round notices say "the nurse in charge", where the guides say "the nurse or senior in
  charge".
- No screen turns controlled drug recording on for a home, so a Registered Manager cannot see or
  change it (H-1518).
- The handover summary still says "absconding" (`care.handover.summary.incident`) where the
  incident form says "Left without agreement".
- A share link's code can be made, but there is no page where the recipient uses it.
- With Medicines due in batch 5, the phone's tab bar may reach eight tabs (H-1527).

## Tests

- `node scripts/check-markdown-links.mjs`: 555 files, no broken links.
- `node scripts/rename-product.mjs --check`: no in-scope old product name left.
- Every bold label in the new and changed guides was checked by a script against `en-GB.json` and
  `mobile.en-GB.json`; the remaining matches are emphasis, not labels.
