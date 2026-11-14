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
- **User guides.** Shifts, Settings, Training and Handover are now "under More"; lone working and
  the handover are also on Today (see Review rounds).

## Review rounds

The clinical safety reviewer and the accessibility reviewer (agents) reviewed the branch at
730b6e792 on 14/11/2026. Both found blockers. Each finding and what was done:

### Clinical safety (DCB0129)

- **B1, hazard log and CSO actions.** The hazard log is updated in the same change: HZ-001, HZ-002,
  HZ-007, HZ-008, HZ-015, HZ-016, HZ-018 and HZ-125 have the new causes, controls and tests, and
  HZ-125's "Shifts tab" line is corrected. The CSO's decisions are H-1646, H-1647 and H-1648. The
  pull request needs the `clinical` label.
- **H1, the stale warning lost its salience (HZ-002).** The banner's warning states (stale, never
  synced, scope too wide) are filled with `warning` and `onWarning`, at least 3:1 against the page
  and the calm banner in every theme. Test: `hazard HZ-002 the stale warning stands apart from the
  calm banner and the page`.
- **H2, lone working deeper under More (HZ-125).** Option (a): while a session is open, Today shows
  the lone-working panel (due or overdue in words, Check in with the identical long-press duress,
  Ask for help), one tap away. Test: `hazard HZ-125 an open session shows check in and ask for help
  on Today`. A badge on More, or Shifts as a tab for lone-working roles, is the CSO's decision
  (H-1647). The Maestro flow `hazard-HZ-125-shifts-and-lone-working.yaml` runs with the device
  check (H-1645).
- **M1, "not recorded" flags pale (HZ-007, HZ-015, HZ-016).** Warning chips keep the container and
  add a 2 pt `warning` outline, not a `warning` fill (which deuteranopes could confuse with
  danger). Test: `hazard HZ-007 hazard HZ-015 hazard HZ-016 a not-recorded flag stands out from its
  surface`. H-130 is re-decided for the phone under H-1646.
- **M2, dark danger pink and level with the primary button (HZ-008).** In dark mode danger is
  `errorContainer` (`#93000a`) with `onErrorContainer` and a 2 pt `error` outline; light stays
  filled `error`. Test: `hazard HZ-008 danger is a red fill with an edge that stands out, apart from
  the primary button`. The CSO decides on device (H-1646).
- **M3, no prompt to acknowledge the handover (HZ-018).** A Handover card on Today opens it in one
  tap, and the More row has a subtitle. The unread state and a badge on More wait for the CSO
  (H-1648).
- **M4, the emergency guides said "Go to Shifts".** Both lone-working guides now say Today while a
  session is open, else More, then Shifts, then Open lone working.
- **L1, calm banner the same as the page (HZ-002).** Calm states sit on the card colour.
- **L2, info and neutral chips alike to protanopes.** Not changed: the icon and the words tell them
  apart. Left to the colour-vision check (H-1645) and the CSO (H-1646).
- **L3, person photo shrank to 40 (HZ-001).** People's rows keep a 48 pt photo or initials
  (`nativeMetrics.personPhoto`).
- **L4, old links land nowhere.** A link from outside the app to `/handover`, `/settings`,
  `/shifts`, `/shifts/lone-working` or `/training` opens `/more/...`: the link handler maps it
  (`movedPath` in `platform/link-params.ts`, tested).
- **L5, stale references.** Fixed in the hazard log, `scheduling.md` (section 22.3 is now "The Shifts
  screen"), `feature-register.md`, `care.md`, H-1051, H-1365 and the shared-device guides (lock and
  unlock, sign out, shared phone: "More, then Settings").
- **L6, H-1527 still open.** Marked done differently: five tabs with More, the same for every role;
  the by-role question goes to H-1647.
- **L7, iOS fields and choices with no edge (WCAG 1.4.11).** A 1 pt outline (accessibility H1).
- **L8, the "No photo on record" placeholder.** Not built yet; unchanged by this branch.

### Accessibility (WCAG 2.2 AA)

- **B1, text on the selection container below AA.** Every word and icon on a selected row or choice
  uses `onAccentContainer`, tested at AA (and its edge at 3:1) on both platforms in every theme. The
  ADR's "AA in every theme" now rests on that test.
- **B2, content under the iOS tab bar.** Every Care scroll view sets
  `contentInsetAdjustmentBehavior="automatic"`; large titles are off on iOS until the scroll view
  is a screen's first child. Proof on an iOS 26 Simulator (scroll to Save, and to the last person
  in a long list) is part of H-1645.
- **H1, iOS fields and choices with no boundary.** A 1 pt outline at 3:1.
- **H2, Android rows merge outside a group.** A row outside a `ListSection` keeps a line under it,
  so the medicines round's and the handover's rows stay apart.
- **H3, capsule chips at large text.** Above 1.3x text, capsules take a 16 pt radius
  (`nativeMetrics.wrapRadius`), so wrapped words stay on the fill.
- **M1, focus visibility.** An invalid field shows a 3 pt border when focused; the Android ripple
  is translucent; rows and choices draw a 2 pt accent outline when focused.
- **M2, Android selected tab hard to see.** The selected icon is in the text colour with a bold
  label. A heavier selected icon variant is not drawn yet.
- **M3, fixed iOS tab colours over Liquid Glass.** The iOS tab bar takes only the brand tint.
- **M4, handover and lone working harder to find.** The Today panel and Handover card (clinical H2
  and M3) and subtitles on the More rows. A badge on More waits for the CSO (H-1647, H-1648).
- **M5, tests.** Added: the theme pairs (selection, chips with outlines, the banner), a render test
  of the More screen and a test of TextField's focused and invalid states. The accessibility
  checklist has a manual-pass row for this release, and H-1645 names the CSO, the accessibility lead
  and the assistive technology.
- **L1, navigator remounts.** The tab set is fixed for the session.
- **L2, More dividers.** A `leadingSize` prop on `ListItem`.
- **L3, More heading under TalkBack.** Check on device (H-1645).
- **L4, user guides.** "In the tab bar" instead of "at the bottom of the screen", and the chained
  steps fixed in the lone-working and shifts guides.
- **L5, literal sizes.** Moved into `nativeMetrics` in `native.ts`.
- **L6, disabled at 0.38 on Android.** Disabled controls are at 0.5 on both platforms.
- **L7, tab bar minimise.** `minimizeBehavior="never"`.
- **H-1644 (tab label size).** The reviewer's conditions (accept on iOS; on Android only at font
  scale 2.0 on a 360 dp phone; never `fontSize` in `labelStyle`) are in H-1644 and the
  accessibility checklist's decisions.

## iOS Simulator check and re-checks (14/11/2026)

The owner ran 730b6e792 in demo mode on the iPhone 17 Pro simulator. It built and ran, with no
Intl crash, the Liquid Glass tab bar, the Large Content Viewer on a long press and Increase Contrast
bringing outlines back. What it found, and what changed:

- **Today would not scroll; the greeting sat under the large title; large titles never shrank.**
  Already fixed in 0ed5e3e3b, which the check did not include: every Care scroll view now adjusts
  for the header and the floating tab bar (`contentInsetAdjustmentBehavior="automatic"`), and large
  titles are off until each screen's scroll view is its first child, which the pinned banners
  prevent today. To be confirmed in the next run (H-1645).
- **Chips ran past their card's edge.** A chip is never wider than what holds it: its words wrap
  inside it, and a wrapped chip takes the smaller corners (`StatusChip.tsx`).
- **After a text-size change, a banner went blank and chips stayed tall until a relaunch.** The
  shared `Text` is drawn afresh at each system text size, so iOS measures it again. Not reproducible
  here: to be confirmed on the simulator.
- **At the largest text the banners took almost half the screen.** A calm sync banner keeps to its
  title above 1.3 times text, with its detail still spoken; a stale, refused or failed banner always
  shows in full (`compactSyncBanner`, HZ-002, HZ-006). The demo line says "Demo: invented people"
  and still speaks the whole sentence.
- **The note's choices were separate cards.** Choices are one grouped list: on iOS an inset
  grouped list with a checkmark and the word "Selected" on the chosen row, as Settings does; on
  Android Material 3 segmented rows with a radio button and the chosen row on the selection
  container. Focus draws a 2 pt ring.
- The grey gear at the top right is the development client's tools button, not the app.

Re-checks of 0ed5e3e3b:

- **Clinical (one gap, Medium):** in dark mode Ask for help was a pale pink as bright as the mint
  Check in beside it. A destructive button now takes the danger chip's deep red fill and bright
  edge (`buttonAppearance`; `hazard HZ-008 hazard HZ-125 Ask for help, a destructive button, ...`).
  Lows left as they were: Ask for help with no open session is under More (H-1647); the help line's
  state is not shared between Today and Lone working; info and neutral chips look alike to
  protanopes (L2, H-1646).
- **Accessibility (no High; three Mediums, all fixed):** the training course's page clears the
  tab bar; an overdue check-in is said once when the panel is open on Today and on Lone working
  (`hazard HZ-125 says an overdue check-in once ...`); focus on a selected choice is visible (the
  choices' redesign above draws a ring; fields in error use `focusOutlineStrong`, 3 pt).

## What is next

- H-1645: run it on the iOS Simulator and an Android emulator or phone, with the CSO and the
  accessibility lead, assistive technology and the warning and danger states. It was checked in a
  web preview of the components only.
- H-1646, H-1647, H-1648: the CSO decides the status colours, lone working under More and the
  handover under More.
- H-1644: the owner and accessibility lead decide on the tab bar's platform-sized labels.
- Liquid Glass for the app's own floating controls (a form's Save bar) with `expo-glass-effect`,
  after the device check.

## Human actions logged

- H-1644, H-1645 (updated after the reviews), H-1646, H-1647, H-1648. Updated: H-1051, H-1365,
  H-1527.

## Tests

- `packages/ui-native/src/logic/theme.test.ts` (rewritten, both platforms): contrast in every
  theme, colours only from tokens, shared brand colours, chips, type, shapes and targets.
- `packages/ui/src/tokens/m3-scheme.test.ts`: the scheme is the one the seed generates.
- `apps/mobile/src/app-state/care-destinations.test.ts`: never more than five tabs.
- `apps/mobile/src/config/tab-icons.test.ts`: every tab icon at every scale, no SF Symbols.
- `apps/mobile`: 92 files, 1,637 tests; `packages/ui-native`: 200; `packages/i18n`: 48; typecheck
  and Biome clean.
