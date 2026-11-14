---
status: "accepted"
date: 2026-11-14
decision-makers: owner (14/11/2026: "the UI is not good, let's do a material 3 for android and similar for iOS with liquid glass"; 07/11/2026: every Thapsus product follows one Material 3 design plan, seeded with the Thapsus teal); lead engineer (Claude Code lead session)
consulted: Thapsus-HR ADR-0254 (the suite's Material 3 scheme); master prompt section 8 (mobile); accessibility and clinical safety reviewers (agents)
informed: everyone working on the phone app
---

# The phone app looks native: Material 3 on Android, Liquid Glass on iOS

## Context and problem statement

The phone app was styled after the web's Apple-like tokens: a blue accent, hairline borders,
saturated status fills, JavaScript tabs with seven or eight destinations, and labels that were cut
off at iPhone width. The owner found it "not good" after the first iOS Simulator run (14/11/2026)
and asked for Material 3 on Android and the iOS 26 Liquid Glass look on iPhone. On 07/11/2026 he
had decided that every Thapsus product follows one Material 3 plan, seeded with the Thapsus logo
teal, Thapsus Care after Thapsus-HR. Section 8 already says to use native navigation "so iOS 26
applies Liquid Glass and Android applies Material 3 automatically".

## Decision drivers

- Native on each platform, so the app feels familiar to carers on cheap Android phones and on iPhones.
- One brand across Thapsus products: the suite's teal.
- Safety information stays as strong as before: status is always an icon and a word, and the most
  serious flags stay the most visible.
- WCAG 2.2 AA in every theme, including high contrast.

## Decision outcome

- **Colour.** Brand and status colours come from the Material 3 scheme generated from the Thapsus
  teal `#0B6B63`, the same method and values as Thapsus-HR (`packages/ui/src/tokens/m3-scheme.ts`,
  written by its test with `UPDATE_M3_SCHEME=1`; a test fails if the file drifts). Both platforms
  use them. Neutral surfaces are each platform's own:
  - Android: Material 3's tonal surfaces (the page `surface-container` in light and `surface` in
    dark, rows on the lowest or high container);
  - iOS: the system's grouped backgrounds, cells, labels and separators (`packages/ui/src/tokens/native.ts`),
    with the secondary label darkened to pass AA.
  High contrast uses Material's higher-contrast scheme on Android and promotes secondary text on iOS.
- **Status chips.** Danger keeps a filled error colour (overdue, allergies, a do-not-resuscitate
  decision), the strongest signal. Warning, success, information and neutral use tonal containers
  with their own text colour. Every chip still shows an icon and a word, and every pair is at least
  4.5:1 in every theme (tested). This replaces section 8's "status colours fixed across themes":
  Material's dark scheme uses lighter status colours, which is how Material keeps them readable on
  dark surfaces.
- **Type and shape.** The platform's system font (SF on iOS through the system stack, Roboto on
  Android), on Apple's text styles and Material 3's type scale, never below 15 points. Corners and
  targets follow each platform: capsules and iOS 26's large corners and 44 pt targets on iOS;
  Material 3's shape scale and 48 dp targets on Android.
- **Navigation.** expo-router's native tabs (`expo-router/unstable-native-tabs`), so iOS 26 draws
  the Liquid Glass tab bar and Android the Material 3 navigation bar, and native stack headers on
  every tab, with large titles on iOS. Both platforms allow five tabs at most, so the bar holds
  Today, Round, Medicines (for those who give medicines), People and More; More holds Handover,
  Shifts, Training and Settings (`app-state/care-destinations.ts`, tested). Their routes move under
  `/more`.
- **Icons.** Lucide, as before. The tab bar takes images, so `apps/mobile/scripts/tab-icons.mjs`
  draws the five tab icons as template PNGs at 1x, 2x and 3x, which each platform tints. Never SF
  Symbols or Material Symbols.
- **Lists.** Grouped lists in each platform's style (`ListSection`): an inset grouped list with
  inset dividers on iOS; Material 3 Expressive segmented rows on Android.
- **The tab bar's labels** are the platform's own size (about 10 points on iOS and 12 sp on
  Android), below section 8's 15-point minimum. Native bars are what section 8 asks for, and each
  platform makes them accessible its own way: iOS shows a large version of an item on a long press
  (Large Content Viewer) and Android scales them with the font size. Forcing 15 points would cut
  the labels off again. The owner and the accessibility lead accept or reject this (H-1644); every
  other text stays at 15 points or more.

### Consequences

- Good, because the app looks and behaves like each platform's own apps, and like Thapsus-HR.
- Good, because the cut-off tab labels are gone: the bar never holds more than five.
- Bad, because Handover, Shifts and Training are one tap further away, under More.
- Bad, because `unstable-native-tabs` may change in a later Expo SDK; the layout is one file.
- Bad, because the look was checked in a web preview of the components, not yet on devices
  (H-1645). The native bars and Liquid Glass only render on the phones themselves.

### Confirmation

- `packages/ui-native/src/logic/theme.test.ts`: every text, control and chip pair meets AA on both
  platforms, in light, dark and high contrast; colours come only from the tokens; both platforms
  share brand and status colours.
- `packages/ui/src/tokens/m3-scheme.test.ts`: the scheme is the one the seed generates.
- `apps/mobile/src/app-state/care-destinations.test.ts`: never more than five tabs.
- The Maestro flows open tabs and More through `open-tab.yaml` and `open-more.yaml`, by test id on
  iOS and by label on Android, where a native tab's id cannot be read.

## Pros and cons of the options

### Native tabs and headers, platform tokens on shared components (chosen)

- Good, because the system draws the parts that carry each platform's look (the tab bar, headers,
  Liquid Glass), and the rest follows from tokens on the existing components.
- Bad, because the platform look lives in token and style branches, which need both platforms in
  every visual check.

### Native component libraries for every control (`@expo/ui`: SwiftUI and Jetpack Compose)

- Good, because every control would be the platform's own.
- Bad, because every screen would be rewritten, the render tests could no longer draw them, and the
  library is early.

### Keep the JavaScript tab bar and restyle it

- Bad, because it can never be Liquid Glass, and it still had to hold up to eight tabs.
