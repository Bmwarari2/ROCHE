# Storybook 10.6.2 in the design system (security)

Branch `fix/ui-storybook-security`, stacked on `fix/web-next-security` (PR #110).

## What changed

- `packages/ui`: `storybook`, `@storybook/addon-a11y`, `@storybook/react` and
  `@storybook/react-vite` 10.6.1 to 10.6.2 (exact pins, kept aligned; `@storybook/builder-vite` and
  `@storybook/react-dom-shim` move with them, while `@storybook/global` and `@storybook/icons` are
  versioned separately and do not change). No other package in the repository uses Storybook.
  10.6.2 fixes GHSA-f2ph-cmg5-wxc8 (CVE-2026-114125, critical, missing origin validation in the
  Storybook preview lets a malicious website inject code) and GHSA-px85-f4q5-jh77
  (CVE-2026-114126, high, code injection into the development server from the local network);
  both affect `>=10.0.0 <10.6.2`. 10.6.2 was published on 12/10/2026, 19 days before this change.
  10.6.3 to 10.6.5 are under two weeks old, so the smallest fixed release was taken. No ADR: a
  patch within the chosen stack.
- Re-resolving `storybook` let pnpm reuse `esbuild` 0.28.2 (already in the lockfile for
  `apps/api`) in place of 0.27.7. Storybook's allowed `esbuild` range is the same in both
  versions. This also clears GHSA-g7r4-m6w7-qqqr (low, Windows-only file read from the `esbuild`
  development server).
- Storybook is a development tool for the design system. It is not part of the web, API or mobile
  builds, and it handles no personal data, so there is no clinical-safety or data-protection impact.

## What is next

- Take a later 10.6.x patch with the next routine dependency update.

## Human actions logged

- None.

## Tests

- `pnpm audit` no longer reports GHSA-f2ph-cmg5-wxc8 or GHSA-px85-f4q5-jh77. The audit has gone
  from 18 findings (1 critical, 3 high of which 2 are ignored) to 15 (no critical, 2 high, both
  already ignored). `pnpm audit --audit-level high` and `pnpm audit --prod --audit-level high` pass.
- `pnpm install --frozen-lockfile`, `pnpm --filter @harbour/ui build-storybook`,
  `pnpm --filter @harbour/ui typecheck`, `pnpm lint` and `node scripts/check-licences.mjs`
  (977 packages, all allowed).
- `@harbour/ui` unit tests: 21 files, 346 tests passing, including
  `packages/ui/src/test/stories.a11y.test.tsx` (233 tests).
