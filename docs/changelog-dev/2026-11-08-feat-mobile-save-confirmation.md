# The phone confirms a save naming the person (HZ-001)

Branch `feat/mobile-save-confirmation`, from main. No migration.

- **What it says.** After a note, chart entry or body map mark is saved, the person's record shows
  what was saved and for whom, for example "Note saved for Ada Example, on this device. It uploads
  when you are online." A correction says "Corrected note".
- **How it looks.** The message is in words with an icon, never colour alone, with a 44 pt Dismiss
  button.
- **How long it stays.** Until it is dismissed or another person's record opens. The save
  announces the same words to screen readers.
- **Where it goes.** Nothing advances to another person: the form goes back to the record or the
  list it came from.
- **Code.** `useSaveAndReturn(personId)` sets the notice (`care/saved-notice.ts`).
  `SavedNoticeLine` shows it under the person header in `PersonRecord`, both on the phone and in
  the tablet split view. The notice is held in memory only.
- **Strings.** New `mobile.form.savedFor*` and `mobile.form.savedWhat.*` strings in en-GB. Welsh is
  marked untranslated.
- **Tests.** `hazard HZ-001 the save confirmation names the person and what was saved`
  (apps/mobile/src/care/saved-notice.test.ts).
- **Maestro.** A step is added to `hazard-HZ-006-offline-note-and-vitals.yaml`. It was not run here
  (no emulator).
- **Hazard log.** HZ-001.
