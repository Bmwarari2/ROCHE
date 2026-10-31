# Tablet split views on the phone app

Branch `feat/mobile-tablet-split`. Phase 2 plan slice 73 (lane G), MOB-013, hazard HZ-001.

## What changed

- **When there are two panes** (`packages/ui-native/src/logic/split-layout.ts`):
  - Two panes need a tablet held in landscape: the shorter side must be at least 600 pt.
  - Both panes must also fit at the reader's text size. The list needs at least 300 pt and the
    detail at least 420 pt at the default size; both minimums grow with text size.
  - Everywhere else the screen keeps the phone's single pane, so Dynamic Type and 200% text never
    clip a pane. That covers phones, portrait, narrow iPad Split View windows and text sizes that
    would squeeze a pane: at 200% text only the 13-inch iPad Pro keeps two panes.
  - It is pure logic with table-driven tests over real device sizes.
- **`SplitView` and `useSplitLayout`** (`@harbour/ui-native`):
  - The list comes first in the tree, so swipe and keyboard order go through the list, then the
    detail.
  - The detail pane opens with a heading that names who or what it shows (44 pt target). When the
    reader chooses another row, the screen reader moves to that heading; it does not move on the
    first draw.
  - `useSplitLayout` follows rotation, window size and text size.
- **`ListItem`**: a chosen row is announced as selected and says "Shown on the right" in words with
  an icon, with a bar on its leading edge. It is never shown by colour alone.
- **Person record**: the record's body is now `apps/mobile/src/components/PersonRecord.tsx`. Its
  route draws it on a phone; the tablet panes draw the same component, point-of-care header first.
- **People**: on a tablet, the chosen person's record sits beside the list.
  - The choice is the route's `person` parameter, so it survives a note or chart saved from the
    record.
  - It is kept by id, so a list that re-sorts as sync applies changes never swaps the record. A
    person who leaves the list leaves the pane.
- **Round**: on a tablet, each task about a person offers "Show record". The record opens beside
  the round, and so does "Record the entry" for a task that needs evidence.
  - A note or chart started from that record opens over the People tab with the record beneath it,
    as on a phone, so saving returns to the person.
- **Handover**: on a tablet, the homes are listed on the left, each with its handover's state as an
  icon and a word. The chosen home's handover is read and acknowledged on the right; the first home
  shows until the reader chooses another.
- **Strings**: new `mobile.split.*` keys in English. The Welsh catalogue takes the English copy and
  lists the keys as untranslated.
- **Maestro**:
  - The demo and live emulator jobs in `.github/workflows/mobile.yml` now run on a phone and on a
    tablet (the `pixel_tablet` profile), with rotation fixed at the device's natural orientation.
  - New flow `tablet-split-views.yaml` (tag `demo`) checks the split on the tablet and the single
    pane on the phone.
  - The existing flows find the same test ids in either layout.

## Not done here

- **The MAR's split view**: slice 73's plan row names the MAR, which waits for the mobile MAR
  (slice 69).
- **Today (gap, agreed with the lead)**: Today is unchanged. It still opens the record as its own
  screen on a tablet. A split for Today is left for a later slice.
- **"The gate"**: the lead confirmed this means the screens gate (round, handover and person
  record), plus People.
- **Responsive web down to 360 px**: the other half of MOB-013, not part of this slice.

## Clinical safety and data protection

- HZ-001 gains a design control and its verification tests (`docs/clinical-safety/hazard-log.md`).
  No clinical rule or calculation changed. The medical-device boundary is unaffected: layout only.
- No new personal data, processing or retention.

## Human actions logged

- H-1050: check the split views by hand with VoiceOver and TalkBack, at the largest text sizes and
  with a keyboard.

## Tests

- `packages/ui-native`: `split-layout.test.ts`. Typecheck and tests pass.
- `apps/mobile`:
  - `split-view.render.test.ts`: reading order, the heading, focus moving on a new choice and not on
    the first draw, the chosen row in words, and "Show record" naming the person.
  - `screens.test.ts`: a record beside a list keeps the point-of-care header. The full suite and
    typecheck pass.
- **Maestro has not run**: the new flow and the tablet runs were written without an Android emulator
  or iOS simulator. The `pixel_tablet` emulator profile also needs confirming on the runner's SDK.
