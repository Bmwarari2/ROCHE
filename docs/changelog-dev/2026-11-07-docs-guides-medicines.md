# User guides: medicines (Phase 2 slice 81)

Branch `docs/guides-medicines`, from `main` at b65e7b61 (after the rename, #181).

## What changed

- 24 new guides and one corrected (`care-worker/run-a-round.md`: the care round is on the phone's
  Round tab; medicines are on neither round).
- **Web (24, slices 50 and 52 to 55)**: the browser round with allergies beside the medicine,
  when-required doses with last given, homely remedies, temperatures, signing as a controlled drugs
  witness, medication error details and printing the MAR (care worker); adding a medicine with the
  dm+d picker, the second check, stopping, reconciliation, controlled drug movements, corrections
  and stock counts, printing a register page, medication reviews, homely remedy protocols, ordering,
  fridges and rooms, stock and witnessed disposal (nurse); the review tracker and the medicines
  reports (Registered Manager). Each cites its hazards.
- **Phone (slices 69 and 70)**: seven guides wait on `docs/guides-medicines-phone`. They describe
  `feat/mobile-meds-cd-offline` with the fixes the lead asked for (the phone stops someone without
  controlled drug permission before recording; a controlled drug conflict decision takes a fresh
  second sign-in step or goes to the web), so they merge only after that pull request and its
  fixes, checked against it.
- The role indexes, the guides README and the register's user docs column link every guide.

## Reviews and decisions

- The accessibility and clinical safety reviewers read every guide; their findings are fixed. The
  main clinical fixes: a when-required dose over the 24-hour maximum is refused, not recorded;
  covert doses only as the current covert administration record says; giving a controlled drug
  cannot be recorded on the web; terms (MAR, eMAR, covert, dm+d, NRLS) are explained and "confirm
  it is you" is in plain words.
- The lead's recommended answers, recorded as H-1517 to H-1520 and H-1541 (provisional, pending
  CSO review): every controlled drug record stays in the paper register until both the web and the
  phone record controlled drugs for a home (the controlled drugs guides say so at the top); the web
  when-required round is accepted for the pilot, with staff reading the protocol in the care plan
  and recording the outcome themselves; escalations go to "the nurse or senior in charge (whoever
  your home gives medicines record management)"; the guides name the open items they depend on.
- For the builders: the round's controlled drugs notice (`medicines.round.cdNotice`) still says to
  record in the controlled drugs register; the register screens are to show a banner where
  controlled drug recording is not turned on (H-1517).

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
