# No SMS at launch (ADR-0132)

Branch `fix/comms-no-sms-at-launch`, from `main` after batch 3c (#174). The owner decided on
06/11/2026 that families get app and email notifications only and that no SMS gateway is contracted
at launch (ADR-0132; H-09, H-105, against the recommendation). Nothing may rely on a text message
that would go nowhere.

## What changed

- `smsGatewayConfigured` (domain) and `smsAvailable(tx)` (API): text messages can be sent only with a
  connected `comms.sms` gateway, never the mock. None exists at launch.
- Lone-worker routes (HZ-125): `checkRoute` takes `smsAvailable`. While it is false a step choosing a
  text message is refused in words (`sms_unavailable`: "Text messages cannot be sent: no text message
  service is set up. Choose a phone notification or email for each step instead."), and a text
  message does not count as reaching people away from the app. `GET /v1/lone-worker/route` says
  `smsAvailable`; the route form offers phone notification, email and in Harbour only and says why.
- Migration 0145 removes `sms` from saved lone-worker routes; a step whose only way away from the app
  was a text message gains a phone notification, so no step is silently weakened to in-app only. Each
  changed route is audited (`scheduling.lone_worker.route_sms_removed`); idempotent; other chains
  untouched. No schema change; the sample removal union in 0144 is unchanged (no new table).
- The delivery job never hands a text message to the mock while no gateway is connected: it is
  skipped as "No SMS gateway".
- Family notifications: `offeredFamilyChannelKinds` offers app and email only; `planFamilyNotification`
  skips a text message channel as `sms_unavailable`. (No family channel screen exists yet.)
- Copy: the route's channel wording and the board's connection notice no longer promise text
  messages. `scheduling.md` and `comms.md` updated. The `comms.sms` port and mock stay.

## Tests

- Domain (route rule table, the words, `smsGatewayConfigured`, family plan); API (refusal in words,
  `smsAvailable`, the delivery job); database (migration 0145); web (`readRoute`, `routeChannels`).

## Follow-ups

- When a gateway is contracted (H-105's criteria), its adapter's provider name and a `connected`
  status turn text messages back on everywhere; the copy then offers them again.
