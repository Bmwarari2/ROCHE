# Import wizard screens (PLAT-014, slice 67 web)

Branch `feat/web-import-wizard`, stacked on `feat/platform-import-wizard` (#150).

## What changed

- `/settings/import` (for members with the import permissions across the organisation, in the
  navigation as "Import people"): choose the home and a CSV file, then match each column to a
  Harbour field or leave it out, with the file's first three rows beside each column (read in the
  browser, HZ-130). A required field left unmatched, or two columns for one field, is said by
  column number before anything is uploaded. Earlier imports are listed with where each stands
  (icon and word).
- `/api/imports/upload`: the upload goes through its own route handler, not a server action (this
  site only, JSON only, the API's 12 MiB cap checked from Content-Length and while reading).
- `/settings/import/[id]`: check the file (the dry run) with what adding the people does in words,
  every error by row and field, each possible duplicate as a tick box naming the other row or the
  record already in Harbour (linked); the commit sends exactly the warnings shown and ticked and is
  held back, with a summary linking to the first box to tick, until every one is ticked and, where
  phones are in use, the no-undo acceptance is ticked; commit with a fresh step-up; the allergy
  status checks listed after; undo while the API says it is available, otherwise a plain statement
  that it is not; discard a staged file. Every step returns focus to the page heading with a
  status saying what was done.
- Strings in en-GB (and cy, marked untranslated). Hazard log HZ-130, records of processing,
  feature register.

## Found, not fixed here

- The SSO settings screens wait for the SSO API (H-899).

## Human actions logged

- H-890 to H-899.

## Tests

- `apps/web/src/lib/imports.test.ts` 39 passed; web unit tests 1476 passed; i18n 48 passed.
- Playwright `e2e/import.spec.ts` 3 passed (axe in light and dark at every step), with
  `smoke`, `export` and `documents` re-run: 11 passed.
- Accessibility reviewer: focus and announcements after each step, the commit summary, per-column
  errors and file errors without a focus move, and plain words ("Add 3 people") fixed.
