# Thapsus-HR link: rota, clocking and absence

Branch `feat/integrations-hr-link-rota`, from `feat/integrations-hr-link-connection`, with
`integration/phase-2-batch-3a` merged for the absence (0107) and time and attendance (0109)
slices (Phase 2 slice 88; INTG-014, SCHED-002, SCHED-004, SCHED-010; ADR-0126). Migration 0142.
Behind `integrations.thapsus_hr`, off by default. Harbour keeps the rota.

## What changed

- **Slice 87 follow-ups.**
  - A wrong leaving date is withdrawn by someone who manages the staff file, with a fresh step-up
    and a coded reason. It is refused, and raised for review, while Thapsus-HR still sends the
    date. When access had ended, sign-in and the ended roles come back, by someone who manages
    members.
  - Each alert is one open task per cause, updated rather than raised again.
- **Absences in** through the absence port: approved leave, sickness and other from confirmed
  members become read-only copies (`absence.source = thapsus_hr`, dates and type only). They block
  rostering and raise cover needs. A change, a cancellation or an absence no longer listed updates,
  cancels or resolves them.
- **Shifts and clock events out.** Neither the rota nor time and attendance publishes per-record
  events, so a delivery sweep over `hr_delivery` sends published shift assignments at mapped homes
  (once, again on change, a cancellation when removed) and clock events in and out. It runs on each
  sync and when a rota is published. Allow-listed fields only; refusals are raised.
- **Staleness note** on the rota builder and the staffing check, in words with the time and an
  icon, for anyone who reads the rota. The older of the employee and absence syncs counts. The sync
  runs every 5 minutes.
- Migration 0142: `absence.source` and `hr_id` with their policies and guard;
  `app.raise_hr_cover_need`; cover-need policies for the sync; `hr_delivery.payload_sha256`.
- HZ-133 controls and tests, records of processing, data standards, and H-1345's recommended
  answers (one person confirms a match, with step-up).

## Left

- Reading shifts back from Thapsus-HR to detect edits made there needs its partner-managed records
  (K2, Phase 19); until then Harbour's copy is the only one and is re-sent when it changes.
- Pay units and rates (slice 89) and the screens and owner guide (slice 90).
