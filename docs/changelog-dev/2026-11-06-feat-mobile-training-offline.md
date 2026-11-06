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
  H-1360 to H-1365 (H-1018 answered).

## What is next

- Try real packages on a device; place Training beside Shifts when slice 71 is merged (H-1365);
  Welsh strings.
