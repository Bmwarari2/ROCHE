---
status: "accepted"
date: 2026-11-14
decision-makers: owner (14/11/2026: "the UI is not good, let's do a material 3 for android and similar for iOS with liquid glass"; 07/11/2026: every Thapsus product follows one Material 3 design plan, seeded with the Thapsus teal); lead engineer (Claude Code lead session)
consulted: Thapsus-HR ADR-0254 (the suite's Material 3 scheme); master prompt section 8 (mobile); accessibility and clinical safety reviewers (agents; review rounds of 14/11/2026, which changed this decision as recorded below)
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
  decision), the strongest signal: `error` with `onError` in light; in dark, `errorContainer`
  (`#93000a`) with `onErrorContainer` and a 2 pt `error` outline, so it stays red and stands apart
  from the light primary button (clinical review M2, HZ-008). Warning, success, information and
  neutral use tonal containers with their own text colour. A warning chip (allergies, resuscitation
  or IDDSI "not recorded", NEWS2 low-medium, due) also has a 2 pt `warning` outline, so it stands
  out from its surface (clinical review M1; HZ-007, HZ-015, HZ-016). Every chip still shows an icon
  and a word. This replaces section 8's "status colours fixed across themes": Material's dark scheme
  uses lighter colours for warning and information, which is how Material keeps them readable on
  dark surfaces. The CSO accepts or rejects these colours (H-1646).
- **The sync banner** (HZ-002). Its warning states (stale, never synced, scope too wide) are filled
  with `warning` and `onWarning`, at least 3:1 against both the page and the calm banner in every
  theme; its danger state is filled with `error`; its calm states sit on the card colour, apart from
  the page (clinical review H1 and L1).
- **AA in every theme.** Every text, control and chip pair is at least 4.5:1 for text and 3:1 for
  edges, on both platforms, in light, dark and high contrast. The first version of this decision
  claimed that without testing text on the selection container, which failed in high contrast
  (accessibility review B1). A selected row or choice now uses `onAccentContainer` for all its text
  and icons, and the claim rests on the tests listed under Confirmation.
- **Type and shape.** The platform's system font (SF on iOS through the system stack, Roboto on
  Android), on Apple's text styles and Material 3's type scale, never below 15 points. Corners and
  targets follow each platform: capsules and iOS 26's large corners and 44 pt targets on iOS;
  Material 3's shape scale and 48 dp targets on Android. Once text is larger than 1.3x, capsules
  take a 16 pt radius, so wrapped words stay on the fill (accessibility review H3). On iOS, text
  fields and choices have a 1 pt outline at 3:1 (WCAG 1.4.11; review H1); an invalid field shows a
  3 pt border when focused, and rows and choices draw a 2 pt accent outline when focused, with a
  translucent ripple on Android (review M1). A disabled control is at 0.5 opacity on both platforms
  (review L6). Component sizes live in `nativeMetrics` (`packages/ui/src/tokens/native.ts`), not
  as literals (review L5).
- **Navigation.** expo-router's native tabs (`expo-router/unstable-native-tabs`), so iOS 26 draws
  the Liquid Glass tab bar and Android the Material 3 navigation bar, and native stack headers on
  every tab (large titles on iOS wait for the scroll views; see below). Both platforms allow five tabs at most, so the bar holds
  Today, Round, Medicines (for those who give medicines), People and More; More holds Handover,
  Shifts, Training and Settings (`app-state/care-destinations.ts`, tested). Their routes move under
  `/more`. A link to an old path from outside the app (`/handover`, `/settings`, `/shifts`,
  `/shifts/lone-working`, `/training`) opens the page at its new place: the app's link handler
  (`app/+native-intent.tsx`, `platform/link-params.ts`, tested) maps it before the router sees it,
  so no saved link lands on a missing screen (clinical review L4).
  - On iOS the tab bar takes only the brand tint, so Liquid Glass keeps its own contrast with what
    is behind it (accessibility review M3), with `minimizeBehavior="never"` so it stays labelled
    (L7). On Android the selected tab's icon is in the text colour, with a bold label (M2).
  - The tab set is fixed for the session, so a permission change never remounts the navigator
    under the user (L1).
  - Every Care scroll view sets `contentInsetAdjustmentBehavior="automatic"`, so content and a
    form's Save button clear the floating iOS tab bar (accessibility review B2). Large titles are
    off on iOS until a screen's scroll view is its first child, since until then they cannot
    collapse.
- **Safety tasks under More.** While a lone-working session is open, Today shows the same
  lone-working panel as the Shifts screen: the next check-in due or overdue in words, Check in with
  the identical long-press duress, and Ask for help, one tap away (clinical review H2, HZ-125).
  Members who take part in the handover see a Handover card on Today, one tap from the handover,
  and the More rows carry a subtitle (clinical review M3, HZ-018; accessibility review M4). Shifts
  under More is unchanged. There is no badge on More and no unread state yet: the CSO decides
  (H-1647, H-1648).
- **Icons.** Lucide, as before. The tab bar takes images, so `apps/mobile/scripts/tab-icons.mjs`
  draws the five tab icons as template PNGs at 1x, 2x and 3x, which each platform tints. Never SF
  Symbols or Material Symbols.
- **Lists.** Grouped lists in each platform's style (`ListSection`): an inset grouped list with
  inset dividers on iOS; Material 3 Expressive segmented rows on Android. On Android a row outside
  a group keeps a line under it, so the medicines round's and the handover's rows never merge
  (accessibility review H2). A row's `leadingSize` sets where the iOS divider starts (L2). People's
  rows keep a 48 pt photo or initials, large enough to tell people apart (clinical review L3,
  HZ-001).
- **The tab bar's labels** are the platform's own size (about 10 points on iOS and 12 sp on
  Android), below section 8's 15-point minimum. Native bars are what section 8 asks for, and each
  platform makes them accessible its own way: iOS shows a large version of an item on a long press
  (Large Content Viewer) and Android scales them with the font size. Forcing 15 points would cut
  the labels off again. The owner and the accessibility lead accept or reject this (H-1644); every
  other text stays at 15 points or more. The accessibility review would accept it on iOS, and on
  Android only if the labels survive font scale 2.0 on a 360 dp phone; `labelStyle` never sets
  `fontSize` (recorded in the accessibility checklist's decisions).

### Consequences

- Good, because the app looks and behaves like each platform's own apps, and like Thapsus-HR.
- Good, because the cut-off tab labels are gone: the bar never holds more than five.
- Bad, because Handover, Shifts and Training are one tap further away, under More. Today's
  lone-working panel and Handover card bring the two safety tasks back to one tap, but nothing
  badges More yet; the CSO rates this (H-1647, H-1648).
- Neutral, because the clinical safety and accessibility reviews of the redesign (14/11/2026)
  changed the status colours, the sync banner, fields, focus and selection, the scroll insets and
  the tab bar before merge. The hazard log records the new causes and controls (HZ-001, HZ-002,
  HZ-007, HZ-008, HZ-015, HZ-016, HZ-018, HZ-125), and the CSO decides H-1646 (status colours),
  H-1647 (lone working under More) and H-1648 (handover under More).
- Bad, because `unstable-native-tabs` may change in a later Expo SDK; the layout is one file.
- Bad, because the look was checked in a web preview of the components, not yet on devices
  (H-1645). The native bars, Liquid Glass and the scroll insets only render on the phones
  themselves; the device check now includes assistive technology, the warning and danger states,
  and a colour-vision-deficiency simulation, with the CSO and the accessibility lead.

### Confirmation

- `packages/ui-native/src/logic/theme.test.ts`: every text, control and chip pair meets AA on both
  platforms, in light, dark and high contrast; colours come only from the tokens; both platforms
  share brand and status colours. Added after the reviews: every word on a selected row or choice
  is AA and its edge 3:1 (accessibility review B1); `hazard HZ-002 the stale warning stands apart
  from the calm banner and the page`; `hazard HZ-007 hazard HZ-015 hazard HZ-016 a not-recorded
  flag stands out from its surface`; `hazard HZ-008 danger is a red fill with an edge that stands
  out, apart from the primary button`, each in every theme.
- `apps/mobile/src/components/today-shortcuts.render.test.ts`: `hazard HZ-125 an open session
  shows check in and ask for help on Today`, and the handover opens in one tap.
- `packages/ui/src/tokens/m3-scheme.test.ts`: the scheme is the one the seed generates.
- `apps/mobile/src/app-state/care-destinations.test.ts`: never more than five tabs.
- The Maestro flows open tabs and More through `open-tab.yaml` and `open-more.yaml`, by test id on
  iOS and by label on Android, where a native tab's id cannot be read.
- Still to confirm on devices (H-1645): content clears the iOS tab bar, the Android tab labels at
  font scale 2.0, and the More screen's heading under TalkBack. The CSO decides H-1646 to H-1648.

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
