# The phone app looks native: Material 3 on Android, Liquid Glass on iOS (MOB-001, MOB-002; ADR-0138)

Branch `feat/mobile-native-look`, on `fix/mobile-ios-demo-findings`.

## What changed

The owner asked for Material 3 on Android and the iOS 26 Liquid Glass look on iPhone (14/11/2026),
following the Thapsus suite design he set on 07/11/2026.

- **Colour.** The Material 3 scheme from the Thapsus teal, generated as in Thapsus-HR
  (`packages/ui/src/tokens/m3-scheme.ts`), gives both platforms their brand and status colours.
  Neutral surfaces are each platform's own: Material 3's tonal surfaces on Android, the iOS grouped
  backgrounds and labels on iOS (`packages/ui/src/tokens/native.ts`).
- **Theme** (`packages/ui-native/src/logic/theme.ts`): the look follows the platform (`platform`,
  overridable in previews), with each platform's type scale in its system font, shapes, emphasis
  weight and touch target (44 pt iOS, 48 dp Android).
- **Components:**
  - buttons are Material 3 filled and tonal buttons with the ripple, or iOS capsules;
  - lists are grouped by the new `ListSection` (inset grouped on iOS, segmented rows on Android);
  - chips are capsules on iOS and Material 3 chips on Android, with danger filled and the rest tonal;
  - cards, the person header, text fields, choices, the sync banner and the demo line lose their
    borders and use tone instead, keeping them in high contrast.
- **Navigation.**
  - Native tabs: the Liquid Glass tab bar on iOS 26, the Material 3 navigation bar on Android.
  - At most five tabs: Today, Round, Medicines, People and More. Handover, Shifts, Training and
    Settings moved under More (`/more/...`).
  - Every tab has a native stack header, with large titles on iOS. Lucide tab icons are drawn as
    template PNGs (`scripts/tab-icons.mjs`).
- **Today and People.** People are listed in grouped rows, and the greeting is smaller under the
  native title.
- **Maestro.** The flows open tabs through `open-tab.yaml` (test id on iOS, label on Android) and
  More through `open-more.yaml`.
- **User guides.** Shifts, Settings, Training and Handover are now "under More".

## What is next

- H-1645: run it on the iOS Simulator and an Android emulator or phone. It was checked in a web
  preview of the components only.
- H-1644: the owner and accessibility lead decide on the tab bar's platform-sized labels.
- Liquid Glass for the app's own floating controls (a form's Save bar) with `expo-glass-effect`,
  after the device check.

## Human actions logged

- H-1644, H-1645.

## Tests

- `packages/ui-native/src/logic/theme.test.ts` (rewritten, both platforms): contrast in every
  theme, colours only from tokens, shared brand colours, chips, type, shapes and targets.
- `packages/ui/src/tokens/m3-scheme.test.ts`: the scheme is the one the seed generates.
- `apps/mobile/src/app-state/care-destinations.test.ts`: never more than five tabs.
- `apps/mobile/src/config/tab-icons.test.ts`: every tab icon at every scale, no SF Symbols.
- `apps/mobile`: 92 files, 1,637 tests; `packages/ui-native`: 200; `packages/i18n`: 48; typecheck
  and Biome clean.
