# Training taken offline on the phone (MOB-007, WORK-006)

Branch `feat/mobile-training-offline`, slice 72 (no PR yet), on `feat/work-elearning` (slice 43).

## What changed

- API: the offline manifest and files of an active course, an attempt started offline by the
  phone's id (refused in words when the course was retired or its package changed), and xAPI
  statements sent on sync with a session. OpenAPI and the typed client regenerated.
- Phone: Settings, then Training courses. A course downloads after a storage check said in words,
  runs from the phone's copy against an offline SCORM and xAPI runtime that never reaches the
  network, and queues its attempt, commits and statements with client UUIDs in `elearning_outbox`,
  sent on sync; refusals show in the API's words. New strings use `app.name` for the product's
  name. Dependencies: `expo-file-system`, `react-native-webview` (MIT).
- Sync: `elearning_outbox` is insert-only, never synced down; no stream or migration added.
- Docs: workforce.md section 14.5, data standards, records of processing, feature register,
  H-1360 to H-1366 (H-1018 answered).

## Review round 1

- Accessibility: status with an icon and a word, warnings with an icon, labels containing the
  visible words, the player titled and named for its course, progress read on Android, waiting
  work listed first, a confirmed removal, a loading message, a Maestro journey (not yet run).
- Security: a content security policy and blocked beacons, sockets and event streams in the
  offline runtime (a platform-level block is H-1366); commits merged and queued at most every five
  seconds and statements capped per attempt; the offline start throttled per member, capped at
  three open attempts a course and answering not found for a used id; statements only for an
  active course, throttled per member first; a stricter folder check; course files removed on
  wipe and hold.

## What is next

- Try real packages on a device; place Training beside Shifts when slice 71 is merged (H-1365);
  Welsh strings.
