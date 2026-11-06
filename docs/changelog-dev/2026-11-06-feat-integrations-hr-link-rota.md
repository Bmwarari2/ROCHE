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
- **Staleness note** on the rota builder, the staffing check, the home's rotas, absences and tasks, in words with the time and an
  icon, for anyone who reads the rota. The older of the employee and absence syncs counts. The sync
  runs every 5 minutes.
- Migration 0142: `absence.source` and `hr_id` with their policies and guard;
  `app.raise_hr_cover_need`; cover-need policies for the sync; `hr_delivery.payload_sha256`.
- HZ-133 controls and tests, records of processing, data standards, and H-1345's recommended
  answers (one person confirms a match, with step-up).

## Reviews

- Accessibility reviewer, request changes:
  - the note is now part of the page with no live region (`Banner` gained `announce={false}`);
  - its time is a `<time>` element;
  - it shows when the check fails;
  - the wording is clearer.
- Security reviewer, request changes:
  - the UK check now runs before any absence or delivery, one run per organisation at a time;
  - a re-sent leaving after a withdrawal ends access (`app.end_relinked_leaver_access` in the leaver
    sweep);
  - delivery keys are derived from the record and payload and written before the call;
  - a refusal is not retried;
  - the role sent is the job title;
  - the withdraw route works only on the link's leavings and only when Thapsus-HR positively shows
    none, with user management across the organisation, a row lock and restored roles keeping their
    end;
  - people get a coded refusal on Thapsus-HR copies;
  - the cover-need function checks the shift's dates.
- Clinical safety reviewer, request changes:
  - malformed records never free a copy, and drift is guarded;
  - open-ended absences block until ended;
  - unknown types are raised;
  - absences for unconfirmed members are raised;
  - absence sync failures are audited, published and alerted after 3;
  - the note shows after a disconnect while copies remain, and on the home's rotas, absences and tasks;
  - `delivery_refused` goes to rota managers.
- Clinical safety reviewer, second pass, request changes (fixed):
  - held drift now has a release: `POST /v1/integrations/hr-link/absences/release`, for the link's
    managers with step-up, a coded reason and the ids they reviewed, re-read from Thapsus-HR; it also
    ends copies after a disconnect (H-1345 answers (6) and (8) updated);
  - copies already over no longer count towards the guard and go at once;
  - the note states the time once, in UK time, in its `<time>` line (also accessibility H1).
- Security reviewer, second pass, approve; its N1 is fixed: a retry of a failed or lost attempt
  keeps its key, and every new attempt takes a key from the delivery row's version, so no two
  attempts share a key, even after two lost answers and a return to the first change (a repeated
  key would have had Thapsus-HR drop the change as a replay).
- Security reviewer on the release route, request changes (fixed): ending every copy only once
  disconnected, never with the flag off while connected; the sync's lock is taken before the link
  is read; the reviewed ids, not a count; reasons fit the mode; the alert closes in both modes and
  the copies record who released them.

## Left

- Reading shifts back from Thapsus-HR to detect edits made there needs its partner-managed records
  (K2, Phase 19); until then Harbour's copy is the only one and is re-sent when it changes.
- Pay units and rates (slice 89) and the screens and owner guide (slice 90).
- A Playwright journey with axe over the note on the rota pages needs a way to seed a stale link in
  the end-to-end environment (no database access there today); the component is checked with axe
  in jsdom.
- Mobile shift screens do not show the note yet (recorded against HZ-133; mobile has no rota or
  cover screens today).
- No screen yet for releasing held drift; the alert task names the action and the API serves it
  (slice 90 screens).
