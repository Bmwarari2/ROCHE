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
  - Phone training (#184): both training guides start from the **Training** tab, with the
    Settings link as a second way in.
  - Controlled drugs (#187): the four register guides start with the banner's own words
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

## Reviews

A clinical safety review and an accessibility review of this branch; their findings are applied.

- **Clinical safety, blocking**:
  - B1, browser round: the turned-on notice is quoted in full; the guide says the register page
    cannot record a dose given, not to record it as another movement or in the paper register as
    well, and to tell the nurse or senior in charge before the dose is due (HZ-115; decision
    H-1517).
  - B2, register print: the PDF says to check the eMAR; where the home's recording is not turned
    on, print from the browser or use the paper register; the PDF is for homes where recording is
    turned on (HZ-122).
  - B3, duty of candour: the regulation 20(9) definition for adult social care, who is told
    instead (regulation 20(7), as `safety.candour.hint` says), the clocks quoted exactly (**Due
    now**, the written notification target in working days from the decision, **Past your
    organisation's target**), HZ-013.
  - B4, discharge and transfer: plan before the person leaves; money items need a ledger approver
    who did not record the exit; the return steps with their labels; a new Important section
    (summary, medicines, receiving provider and GP before leaving; a controlled drug leaving
    recorded in the paper register with a witness; notifications submitted only by the Registered
    Manager or owner; HZ-013, HZ-023, HZ-115, HZ-121); what can be added after the person leaves
    (care given before, sent late from a phone).
  - B5, admission: the safety-critical welcome items that cannot be not applicable (from
    `DEFAULT_WELCOME_CHECKLIST`), allergies ticked only when the top of the record shows them,
    medicines reconciliation after admission (HZ-001, HZ-005, HZ-007, HZ-016, HZ-121); the
    pre-admission guide says its allergies do not reach the top of the record (HZ-007, HZ-015,
    HZ-016).
- **Accessibility, blocking**: the opt-out wording quoted on the details page (A5); who can record
  an enquiry, now including administrators or receptionists (A6); every `approvals.sla` wording
  and the candour target on the approvals page (A7).
- **Non-blocking**: "HZ-115; decision H-1517" wherever H-1517 was cited alone; hazard ids in the
  clinical guides; checking identity changes against an official document (HZ-001); **Open from
  earlier** may leave older tasks out; an investigation action's owner must manage incidents at
  the location; incident trends are for the chosen location and "or more" means there may be
  more; break-glass explained on the home page; "scope" and "module" replaced in the approvals
  guide; the property signing and return labels; legal hold and destruction limited to the owner,
  the quality and compliance lead or a role given retention management, with the 10-character
  reason, the date a document went past its period and "Title not shown"; the controlled drugs
  box wording; evidence pack redaction and release by someone else; suspension signs out
  everywhere unless they also work for another organisation; "beside **Shifts**" dropped from the
  phone training guides.
- **CSO decisions** logged in `docs/plans/human-actions.md` as H-1590 to H-1595 (numbered at
  merge), each provisional pending CSO review at the testing phase (ADR-0132): recording a
  controlled drug dose once recording is on (G1), the register PDF footer (G2), a controlled drug
  leaving with the person (G3), allergies and the photo not recordable on the web, a pre-pilot
  blocker (G4), the candour wording and working-days target (G5), and approving these guides as
  the training control (G6).
- **Product fixes needed**:
  - The turned-on round notice (`medicines.round.cdNoticeTurnedOn`) points to a register that
    cannot record a dose given (H-1590).
  - The register PDF footer names the eMAR, not the record that applies at the home (H-1591).
  - No screen shows or sets controlled drug recording for a home (H-1518).
  - `people.exit.archiveConfirmButton` "Yes, archive the record" breaks `packages/ui/CONTENT.md`.
  - `safety.notification.deadline` says "Thapsus Care's target" where the candour record says
    "your organisation's target".
  - `approvals.truncated` says "module", which staff do not use.
  - The handover summary still says "absconding" (`care.handover.summary.incident`).

## Tests

- `node scripts/check-markdown-links.mjs`: 556 files, no broken links.
- `node scripts/rename-product.mjs --check`: no in-scope old product name left.
- Every bold label in the new and changed guides was checked by a script against `en-GB.json` and
  `mobile.en-GB.json`; the remaining matches are emphasis, not labels.
