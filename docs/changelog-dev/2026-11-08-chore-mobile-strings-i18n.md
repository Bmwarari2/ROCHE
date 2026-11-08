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
- **Left as they are.** The device-integrity reasons shown in Settings come from the integrity
  check's own messages, in another module, and are a follow-up.
