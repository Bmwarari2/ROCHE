# The phone's last hard-coded strings go through the catalogue (section 5.4)

Branch `feat/mobile-strings-i18n`, from main. No migration. The English wording is unchanged: each
string moved as it was, so the Maestro flows and the approved copy still match.

- **Sync banner** (HZ-002, HZ-006).
  - `ui-native`'s `describeSyncBanner(input, words)` and `SyncBanner` now take
    `SyncBannerWords`, built in the app with `syncBannerWords(t)` from `mobile.syncBanner.*`.
  - The English constants are gone: the titles, the stale and never-synced warnings, the scope
    refusal, the retry button and its hint, and "Last synced ...".
  - `formatRelativeTime` and `formatLastSynced` are removed. Their table-driven tests now check the
    catalogue's wording.
  - `ui-native` has `@harbour/i18n` as a dev dependency, for its tests only.
- **Lock screen.** `mobile.lock.*`.
- **Sign-in.** `mobile.signIn.*`, including the sign-in error messages (`mobile.signIn.error`,
  one select).
- **Settings.** `mobile.settings.*`.
  - The auto-lock duration is one plural message (`mobile.autoLock.duration`), not joined
    fragments.
- **Other screens.** The mode chooser, the Manage and Family placeholders, the splash and the empty
  people list: `mobile.mode.*`, `mobile.splash.*` and `mobile.people.*`.
- **Welsh.** Every new key is marked untranslated in `mobile.cy.status.json`.
- **Also moved, after the accessibility review.**
  - The unlock failures and the "could not be unlocked" message (`mobile.unlock.*`).
  - The re-download refusals, as one plural (`mobile.settings.resync*`).
  - The device-integrity reasons (`mobile.integrity.reason`).
  - The development-build line.
  - The reset notice's button, now "Hide message", as on the save confirmation.
  - The banner's last-sync sentence now carries its own full stop, so the detail is joined whole
    sentences, never fragments.
- **One wording change.** "Device check: not checked yet" (it was "Not checked yet") reads as a
  sentence.
- **Left for a follow-up.** Some select messages use `other` for a real case. The `{state}` and
  `{duration}` labels take translated values, which Welsh translators need to know about.
