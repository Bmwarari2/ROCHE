---
status: accepted
date: 2026-10-11
decision-makers: Claude Code (lead engineer)
consulted: master prompt section 8; packages/ui
informed: everyone working on web and mobile UI
---

# Design system implementation choices

## Context and problem statement

Section 8 defines the tokens and the 15 Phase 0 components. Building them raised choices the section
does not settle.

## Decision outcome

- One platform-neutral token object (`packages/ui/src/tokens/tokens.ts`, exported as
  `@harbour/ui/tokens`) feeds both `tokens.css` and `@harbour/ui-native`. A test fails if the CSS and
  the object drift.
- Additions, no renames: `focusRing` per scheme; `statusFill`, so the "not applicable" chip is always
  #6e6e73 (white on the dark theme's #86868b fails contrast); `fontFamily.webSans` names
  "Inter Variable" (the Fontsource family name) before "Inter".
- Status colours are fixed across themes and status chips render them as fills with white text
  (5.08:1 to 5.38:1), always with an icon and a word.
- `tokens.css` lives at `packages/ui/src/styles/tokens.css` and is exported as `@harbour/ui/tokens.css`
  rather than at the package root.
- Tailwind 4's default palette and breakpoints are removed; breakpoints are sm 735, md 1069 and
  xl 1441 px, so `max-sm:` means 734 px or below. A default class such as `text-gray-600` does nothing.
- Components use `hb-*` classes in `@layer components`, so they render identically wherever the
  package is compiled. Interactive components are marked `"use client"`; Button, Card, Tile, PageHeader,
  EmptyState, StatusChip, Timeline and TextField stay server-safe.
- Input borders use `--text-tertiary` to reach 3:1 against the background (`--border` is about 1.5:1).
- Apps import only `@harbour/ui/styles.css`, use `@tailwindcss/postcss`, and list `@harbour/ui` in
  `transpilePackages`.

### Consequences

- Axe runs on every story in both themes in jsdom, with `color-contrast` disabled there because jsdom
  cannot compute it; real-browser contrast is checked by Playwright with axe on the web app.
