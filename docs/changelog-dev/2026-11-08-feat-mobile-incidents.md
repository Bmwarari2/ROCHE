# Phone incidents (08/11/2026)

Branch `feat/mobile-incidents`, from `main` at 9cfb4c4c. No migration. MOB-006, HZ-141 (new), H-1630.

## What changed

- **Reporting.** A carer can report an incident from a person's record on the phone, with or without a connection.
  - The form asks for: what happened (every type the web offers), when, a description, what was done straight away, and whether emergency services and the GP were contacted. Each contact question takes yes, no or "Not known yet"; "Not known yet" is sent as unknown (HZ-090).
  - The person whose record it was raised from is on the report as affected.
- **Before saving.** The form opens with a warning: nobody is alerted until the phone is online and the report is sent. If someone is in danger, the carer should tell the person in charge or call 999 first (HZ-141).
- **Queueing and sending.** The report waits in `incident_outbox`, an insert-only table, and is sent to `POST /v1/incidents` under its device id, so a resend records once. The server runs the classifier and its clocks from when the incident happened.
- **On the record.** After saving, the record:
  - confirms the save naming the person;
  - lists reports waiting to send;
  - shows a refused report under needs attention with its type, its words and advice to report it on the web.
- **Round on a tablet.** The form is also on the round's stack.
- **Docs.** Updated care.md, data-standards (`incident_outbox`), records-of-processing, the feature register (MOB-006), the hazard log (HZ-141) and human actions (H-1630, provisional).

## Not yet

- Incidents synced down to the phone.
- The falls questions asked on the phone (today they go to the person in charge as a task).
- Other people or staff on the report.
- Linking body map marks.
- Maestro: not run, because there is no emulator here.
