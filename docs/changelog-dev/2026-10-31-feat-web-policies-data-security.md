# Policy library, read-and-sign and data security screens

Branch `feat/web-policies-data-security` (slice 65, part 1: QUAL-008 and QUAL-012). Built from
`feat/quality-policy-library`, with `feat/quality-data-security-evidence` merged in. The dashboard
and PIR screens wait for slice 47.

## What changed

- Policies (`/policies`, sidebar for everyone): "To read and sign" from `/v1/me/policies`. The
  library shows each policy's version in force and its review status. A policy page shows the
  version in force with the sign form and, for managers, who has read and signed. Managers can
  draft minor or major changes and publish them; when a second reviewer is required, the author
  is told that someone else must publish. Managers can also retire a policy. A superseded version
  says "Superseded: version N is in force" (HZ-128).
- Data security (`/quality/data-security`, for organisation-wide `quality.dsar.manage`):
  - the DSPT status for the financial year;
  - Cyber Essentials, Cyber Essentials Plus and the ICO registration, where a missing record shows
    as "Missing: no record" and never as current;
  - assertions with linked evidence, where met without evidence is counted apart;
  - submissions, one a year with corrections;
  - certificates.
- Every status is an icon plus a word, every form posts, and all strings are ICU under
  `quality.policies.*` and `quality.dataSecurity.*` (Welsh placeholders listed as untranslated).
- A refusal the API names in its own words (such as evidence required) is shown in those words
  instead of "could not save just now".
- `e2e/support.ts` `settleAnimations` no longer waits on animations in content that is not
  rendered (inside a closed `<details>`), which never finish and hung the journey.
- The accessibility review's fixes:
  - `@harbour/ui` `base.css` sets `scroll-padding-top` to the app bar's height. A field reached
    from an error summary no longer stops under the sticky bar (WCAG 2.4.11), and the journey's
    workaround is gone.
  - Retiring checks the contract's 10-character minimum at the field.
  - A retired policy says so; superseded versions say none is in force.
  - API refusals sit at their fields (evidence, notes, future dates, a short name in use).
  - A draft that cannot be published yet says what it needs.
  - Stopping the last evidence for a met assertion needs a confirm box.
  - Buttons name what they act on.
  - Each policy page has its own title.
  - Older certificate records say "Replaced by a newer record".
  - Counts read as one phrase.
  - Heading levels, the roles hint and the plural are fixed, and `<details>` keeps its marker.

## Merge notes

- Migration journal: the policy library migration 0087 had an earlier `when` than the breach
  register's 0082. It was moved to 0082's `when` plus one, so `idx` and `when` both increase.
- `docs/specs/quality.md` has two sections numbered 18 (policy library and data security), as
  merged; main has its own duplicate 18. The screens are section 21.

## Found, not fixed here

- A dev database that applied later migrations before 0071 skips 0071 (Drizzle compares `when`
  with the last applied migration), so its columns are missing. Here it was applied by hand.
- From the accessibility review, left for later:
  - After saving on the assertions page, focus returns to the h1 rather than the card just saved.
    `RecordedArrival` is shared, so an optional focus target belongs in its own change.
  - `RecordedArrival` mounts its `role="status"` already filled in, which some screen readers do
    not announce (H-919).
  - "Registered Manager" is in title case next to "Deputy manager"; the repository mixes both, so
    this needs one decision.
  - The policy short name could be worked out from the title.

## Human actions logged

- H-910 to H-919.

## Tests

- Web unit tests 1474 passed (including `policies.test.ts` and `data-security.test.ts`), i18n 48
  passed and ui 350 passed. Biome and typecheck are clean.
- `e2e/policies-data-security.spec.ts`: 2 passed, with axe in light and dark themes. It covers:
  - the retire reason refused, then the retirement;
  - "Missing: no record" on the overview;
  - the refused state checked as it falls.
