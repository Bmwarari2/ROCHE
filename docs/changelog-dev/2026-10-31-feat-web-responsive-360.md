# Responsive web down to 360 px

Branch `feat/web-responsive-360`. Phase 2 plan slice 74, MOB-013 (the web half).

## What changed

### Tests that find it

- **New Playwright project `mobile-360`**, at 360 × 740 with touch, runs:
  - the smoke journeys;
  - a sample journey from each module: care record, round, incidents, tasks, documents, search and
    team. The handover journey is left out because it acknowledges the shift's handover, which the
    desktop project has already done against the same database; its two screens are in the screen
    checks;
  - the new `apps/web/e2e/responsive.spec.ts`.
- **What `responsive.spec.ts` checks**, across 37 screens from every module as the manager and the
  owner:
  - no horizontal page scroll;
  - every interactive control at least 44 px, including inside the phone menu and the account menu.
    Radios and checkboxes are measured by their card; only links inside a sentence are exempt;
  - axe passes;
  - the app bar and navigation work at that width;
  - three screens still reflow with text at 200%, and the check confirms the text actually grew.
- **New project `mobile-320`** repeats the screen checks at WCAG 1.4.10's own 320 px.
- **Shared journey steps**:
  - `openModules` and `closeModules` (`apps/web/e2e/support.ts`) use the sidebar on a wide screen
    and the phone menu on a narrow one.
  - The axe helper scans from the top of the page, so the sticky app bar never hides a target just
    because of where an earlier step scrolled.

### Fixes in `@harbour/ui`

- **Phone navigation**:
  - At 734 px and below the sidebar gives way to a "Menu" button, with a visible word, at the start
    of the app bar.
  - The button opens the modules with their labels in a sheet (new `NavMenu` component, and a new
    `leading` slot on `AppBar`).
  - The sheet traps focus, closes on Escape or when a module is chosen, and returns focus to the
    button. The page keeps its full width.
- **Text size**: type, button and navigation text sizes are now in rem. They are 16 px per rem at
  the default, so the page looks the same, but the browser's text-size setting now resizes them
  (WCAG 1.4.4).
- **The phone app bar**:
  - The product name gives way beside the Menu; Home is in the menu.
  - The switchers keep a 44 px floor and the side padding is trimmed.
  - The bar grows with large text instead of clipping it.
  - Switcher text is 15 px, the phone minimum.
- **Buttons, cards and controls**:
  - Buttons never exceed their column. On phones they wrap only words longer than the line, with a
    softer radius when they wrap.
  - Card headers and actions wrap.
  - Cards and steppers use 16 px padding on phones.
  - Segmented controls wrap.
  - Radio and checkbox controls are 24 px.
- **44 px links on phones and touch screens**:
  - The collapsed sidebar counts its border, so its links are 44 px.
  - Links in table cells get a 44 px hit area, and are at least 44 px wide, without taller rows.
  - Links standing alone in a list item, definition, cell, paragraph or heading get a 44 px hit area.
- **Scrolling**: the page keeps scroll padding the height of the app bar, so whatever is scrolled to
  or focused never lands under it (WCAG 2.4.11).

### Fixes on the screens

- The risk assessments template picker no longer has a fixed minimum width.
- The task list's person link is a 44 px target.
- The communication flag never grows past its column.

## Not done here

- **Coverage**: the checks sample 37 of the 74 screens and run in Chromium only. Not covered:
  - sheets and the inspector panel opened on each screen;
  - Safari and Firefox;
  - a real phone with the on-screen keyboard.

  H-1070 asks for that by hand.
- **Tablet split views**: the other half of MOB-013, on `feat/mobile-tablet-split` (slice 73). Both
  branches edit the MOB-013 row of the feature register; whoever merges second keeps both
  descriptions.

## Clinical safety and data protection

- No clinical rule, calculation or personal data changed.
- The point-of-care header and its flags reflow inside the narrower column, and their words stay
  whole.

## Human actions logged

- H-1070: check by hand on a real iPhone and Android phone at 360 px, and with the browser's text size
  at 200%.

## Tests

- `packages/ui`: unit tests pass, including the new `NavMenu.test.tsx` and the rem-based
  `tokens.test.ts`.
- `pnpm lint` and `pnpm typecheck` pass.
- Playwright, all three projects (desktop `chromium`, `mobile-360` and `mobile-320`), was run
  locally against a freshly seeded demo tenant on 31/10/2026: 277 passed, none failed. This was in
  Chromium with the sandbox's own browser build, which differs from the build this Playwright
  version pins, through a local configuration that was not committed.
- The accessibility reviewer's findings are fixed (navigation drawer, rem type, button wrapping,
  table-link hit areas, 15 px switcher text, segmented wrap, phone padding, a stricter target check,
  a meaningful 200% test and a 320 px project). One more is left as a note: overflow hidden inside a
  clipping container is still counted as fitting.
