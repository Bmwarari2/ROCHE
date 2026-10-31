# User guides per role and the Phase 1 walkthrough (section 19)

Branch `docs/user-guides-phase-1`.

## What changed

- `docs/user-guides/`: 42 task-based guides, one task each, for the Phase 1 web screens on `main`
  (to the merge of #121). Folders for all staff, care worker, senior carer or team leader, nurse,
  Registered Manager, owner, data protection lead, family member and inspector, each with an index
  that links every guide the role uses. The README sets the format and holds the table from
  register rows to guides.
- Wording follows the screens: button, heading and field names come from `en-GB.json`, and steps
  from the e2e journeys. The guides say plainly what "not recorded" means, when step-up applies,
  who cannot do what (the raiser cannot close an incident; only the Registered Manager and owner
  record a notification as submitted; an author cannot approve their own letter template; whoever
  entered paper records cannot reconcile the outage), that Harbour does not send notifications to
  the regulator, and that NEWS2, MUST and the classifier support judgement and never replace it
  (HZ-013 and the validated-tool hazards ask for this in the user guide).
- Features with no web screen are named as such in the guides, never given steps: consent,
  capacity and DoLS recording, sharing decisions, duty of candour, the medical examiner pack,
  investigations, documents, tasks, retention, member role changes, and the inspector's link page.
- `docs/demo/phase-1-walkthrough.md`: a 45-minute scripted demo against the local demo seed, with
  which demo user to sign in as, which invented resident to open, what to point out, and how to
  get step-up in a live demo (an authenticator app set up beforehand; the e2e passkey works only
  in Playwright).
- `docs/specs/feature-register.md`: the user docs column links the guides for 34 rows (PLAT-004,
  006, 007, 013, 015, 018, 023; PEOP-001, 002, 008, 009; CARE-001 to 003, 006, 007, 009, 010, 012
  to 015, 021, 022; SAFE-001 to 005, 009; OPS-028; COMMS-001, 006, 007). No status cell changed.

## What is next

- A guide for each Phase 1 row still without one, written with its screen: PLAT-002, 009, 011,
  012; PEOP-003, 005, 007, 010, 013; SAFE-007, 008, 010; QUAL-003 (the inspector page is a
  placeholder until the recipient page exists), QUAL-009; INSI-001; INTG-011; the MOB rows.
- `docs/plans/phase-1-gate.md` section 6 still says no user guides exist; update it with the next
  status update.
- Screen findings for follow-up (listed in the pull request): the incident page does not show
  post-fall urgent-advice tasks; acknowledging an overdue notification alert stops its escalation;
  the inspector link has no page to enter the code; body map marks are not linked to incidents;
  the downtime pack's step-up is not marked in the permission matrix; backup codes cannot be
  entered at sign-in.

## Human actions logged

- None.

## Tests

- `pnpm check:links` (178 files) passes. Documentation only; no code changed.
