# The phone app on iOS: plural messages, the demo label and a deprecated call (MOB-001, MOB-002)

Branch `fix/mobile-ios-demo-findings`.

## What changed

The first run of the phone app in the iOS Simulator (Xcode 26.5, iPhone 17 Pro on iOS 26.5, demo
mode, 14/11/2026) found these. Every person on screen was invented.

- **Today crashed on iOS.** Hermes on iOS has no `Intl.PluralRules` and no `Intl.Locale`, so the
  first plural message ("{count, plural, ...}") threw "Intl.PluralRules is not available in this
  environment". The unit tests run in Node, which has both, so they never saw it. The app now starts
  from `apps/mobile/index.ts`, which loads `src/platform/intl-polyfills.ts` before expo-router:
  `@formatjs/intl-locale` and `@formatjs/intl-pluralrules` (MIT), with plural data for English and
  Welsh. Each one installs itself only where the engine's own is missing. Android's Hermes is assumed
  to lack them too until a device run shows otherwise.
- **The mode chooser had no demo label.** It now shows the same "Demo mode: invented people, not
  real records." line as every signed-in screen (`DemoNotice`), and its words come from the
  catalogue (`mobile.mode.*`, `mobile.demo.notice`; Welsh marked untranslated).
- **`InteractionManager` is deprecated** in React Native 0.86, where it only waits for the next
  tick. The save confirmation is now announced on the next tick as before, queued behind what
  VoiceOver is already saying about the screen it returns to.
- The lockfile gains only the polyfills' 46 lines. pnpm 10.28.0 also wants to drop 42 `libc:` lines
  that another pnpm version wrote; that churn is left out.

## What is next

- **Cut-off tab labels** ("Hand…", "Settin…" at iPhone 17 Pro width): Care mode can show up to eight
  tabs, and both platforms allow five. This is fixed with the move to native tabs (Liquid Glass on
  iOS 26, Material 3 on Android) in the next pull request.
- **No Face ID prompt at a cold start in the Simulator.** The database key is read with
  `requireAuthentication`, so on a phone that read shows the prompt; the Simulator does not enforce
  the keychain's biometric protection. Nothing changes in code; it is checked on a real iPhone with
  H-125.
- Run the same flows on an Android emulator to confirm Android's Hermes needs the polyfills.

## Human actions logged

- None. (H-125 already covers the real-iPhone check.)

## Tests

- `src/platform/intl-polyfills.test.ts` (3): with `Intl.PluralRules` and `Intl.Locale` removed as on
  Hermes, a plural message throws without the polyfills (red before this change, with
  `mobile.today.peopleCount`); with them, every en-GB and Welsh message formats for 0, 1, 2, 3, 6 and
  7, which reaches all six Welsh plural forms; the app entry loads them before expo-router.
- `src/components/mode-chooser.render.test.ts` (3): the demo line in a demo build and not in a live
  one; the three modes from the catalogue.
- `apps/mobile`: 89 files, 1,618 tests pass; `packages/i18n`: 48 pass; typecheck and Biome clean.
- `expo export --platform ios` bundles from the new entry.
