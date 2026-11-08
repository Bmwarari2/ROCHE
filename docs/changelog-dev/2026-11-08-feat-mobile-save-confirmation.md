# The phone confirms a save naming the person (HZ-001)

Branch `feat/mobile-save-confirmation`, from main. No migration.

- **What it says.** After a note, chart entry or body map mark is saved, the person's record says
  what was saved, for whom and when, for example "Note saved for Ada Example at 14:05, on this
  device. Whether it has been sent shows on the entry below." It never claims an upload, so it
  cannot contradict the entry's own state (HZ-006). A correction says "Corrected note".
- **How it looks.** Words with an icon, and a 44 pt "Hide message" button. Hiding it moves screen
  reader focus to the first action.
- **How long it stays.** Until it is hidden, another person's record opens, the app locks or signs
  out, or 15 minutes pass.
- **Screen readers.** It is announced once, after the screen changes. The line is not a live region,
  so it is not heard twice.
- **Code.** `useSaveAndReturn(personId)` sets the notice (`care/saved-notice.ts`).
  `SavedNoticeLine` (with `SavedNoticeView`) shows it under the person header in `PersonRecord`, on
  the phone and in the tablet split view. The vault clears it whenever it is not unlocked. It is held
  in memory only.
- **Strings.** One whole sentence per kind, through an ICU `select`
  (`mobile.form.savedFor`, `mobile.form.savedForDemo`), plus `mobile.form.savedDismiss`. Welsh is
  marked untranslated.
- **Reviews.** The accessibility and clinical reviews are folded in: announced after the screen
  change, focus moved after hiding, expiry and clearing on lock, whole sentences, no upload claim,
  "Hide message", and the hazard row marked as partly built.
- **Tests.** `hazard HZ-001 the save confirmation names the person, what was saved and when`
  (care/saved-notice.test.ts) and a render test (components/saved-notice.render.test.ts).
- **Maestro.** A step is added to `hazard-HZ-006-offline-note-and-vitals.yaml`. It was not run here
  (no emulator).
- **Not yet covered.** Medicines and the other forms.
