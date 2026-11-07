# No SMS at launch (ADR-0132)

Branch `fix/comms-no-sms-at-launch`, from `main` after batch 3c (#174). The owner decided on
06/11/2026 that families get app and email notifications only and that no SMS gateway is contracted
at launch (ADR-0132; H-09, H-105, against the recommendation). Nothing may rely on a text message
that would go nowhere.

The clinical review found that a phone notification reaches no member of staff either: staff phones
do not register for notifications yet, so the delivery job finds no destination and skips it. So at
launch email is the one channel that reaches staff away from Harbour, and the lone-worker route now
asks for it at every step (the safer reading, agreed with the lead).

## What changed

- `smsGatewayConfigured` (domain), `smsAvailable(tx)` and `STAFF_PUSH_AVAILABLE` (API): a text
  message counts only with a connected `comms.sms` gateway (never the mock), a phone notification
  only once staff phones receive them. Neither is true at launch.
- Lone-worker routes (HZ-125): `checkRoute` takes `smsAvailable` and `pushAvailable`. A step must
  include a channel that can reach staff (email at launch), and choosing a text message without a
  gateway is refused in words (`sms_unavailable`). A text message that later cannot be sent never
  switches a saved route off. `GET /v1/lone-worker/route` says `smsAvailable` and `pushAvailable`;
  the route form offers phone notification, email and in Harbour, and a note (tied to each step's
  channels) says why.
- Migration 0145 removes `sms` from saved lone-worker routes and adds email to every step without
  it, so every route still alerts someone away from the app. Each changed route is audited
  (`scheduling.lone_worker.route_sms_removed`) and its managers get a task to check it
  (`required_permission` `scheduling.lone_worker.manage`). Idempotent; other chains untouched; no
  schema change; the sample removal union in 0144 is unchanged (no new table). It runs before this
  code serves requests, as migrations do before each deploy.
- The delivery job records a text message as skipped "No SMS gateway" rather than handing it to the
  mock.
- Family notifications: `offeredFamilyChannelKinds` offers app and email only; `planFamilyNotification`
  skips a text message channel as `sms_unavailable`. (No family channel screen exists yet; H-1482.)
- Copy: the route's channel wording, the board's connection notice ("by email") and the specs no
  longer promise text messages or phone notifications. The `comms.sms` port and mock stay.

## Tests

- Domain (route rule table at launch and later, the words, `smsGatewayConfigured`, family plan); API
  (text message and phone-notification-only refusals in words, a saved route kept on, the flags,
  the delivery job); database (migration 0145: email added, text messages removed, audit, task,
  idempotent); web (`readRoute`, `routeChannels`); Playwright (the lone-working journeys).

## Reviews

- Clinical safety: not mergeable at first (the phone-notification fallback reached no one; the
  HZ-125 entry overstated). Fixed as above; re-review requested.
- Accessibility: mergeable; the note is now tied to each step's channels, its wording says what to
  do and that saved text messages are removed, and the refusal words match.

## For the CSO

- H-1481: accept a lone-worker alarm path that reaches staff by email only at launch.
- H-1482: what a family member whose only channel is a text message is told.
