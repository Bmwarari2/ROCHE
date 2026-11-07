# User guides: medicines (Phase 2 slice 81)

Branch `docs/guides-medicines`, from `main` at b65e7b61 (after the rename, #181).

## What changed

- 31 new guides and one corrected (`care-worker/run-a-round.md`: the care round is on the phone's
  Round tab; medicines are on neither round).
- **Web (24, slices 50 and 52 to 55)**: the browser round with allergies beside the medicine,
  when-required doses with last given, homely remedies, temperatures, signing as a controlled drugs
  witness, medication error details and printing the MAR (care worker); adding a medicine with the
  dm+d picker, the second check, stopping, reconciliation, controlled drug movements, corrections
  and stock counts, printing a register page, medication reviews, homely remedy protocols, ordering,
  fridges and rooms, stock and witnessed disposal (nurse); the review tracker and the medicines
  reports (Registered Manager). Each cites its hazards.
- **Phone (7, slices 69 and 70)**: giving medicines, scanning a pack, the medicines PIN, witnessing
  and giving a controlled drug, corrections and reviewing doses recorded twice. They describe
  `feat/mobile-meds-cd-offline` with the fixes the lead asked for (the phone stops someone without
  controlled drug permission before recording; a controlled drug conflict decision takes a fresh
  second sign-in step or goes to the web), carry an "Arrives with the phone release" line, and are
  checked against that pull request before it merges.
- The role indexes, the guides README and the register's user docs column link every guide.

## No screen yet, so no guide (or only part)

- MEDS-006 self-administration assessments (H-1281): no web screen; the level shows on the round.
- MEDS-004: no screen creates, reviews or ends a covert administration record.
- MEDS-003: the PRN protocol's text and the outcome check after a dose are not on the web.
- MEDS-013: approving a competence override (only the overrides report exists).
- MEDS-002 on the web: recording a dose already given, corrections, giving a controlled drug and
  reviewing a dose recorded twice. On the phone: wristband scans (H-1433), "taken by the person"
  and "given by family", a witness for other doses, an early dose with a reason, controlled drug
  corrections and stock checks.

## Found, not fixed here

- One state, two wordings: "Difference found" (chip) and "Check found a difference" (status);
  "Not yet checked" beside "Imported, not yet checked".
- Disposal says "a mistake is put right with a stock count", which replaces the balance rather
  than undoing the disposal.
- The witness form says a signature "lasts a short time" without saying how long.
- Orders refuse controlled drugs and no screen says how they are ordered.
- On the phone (sent to the mobile builder): the controlled drug permission check before
  recording, step-up on controlled drug conflict decisions, refused medicines records shown as
  "Entry for …", and the branch's strings still saying the old product name.
