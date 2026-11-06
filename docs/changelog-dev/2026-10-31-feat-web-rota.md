# Rota and staffing planner screens (slice 59)

Branch `feat/web-rota`, stacked on `feat/sched-rota-builder` (slice 21, which includes the
dependency tool of slice 12).

## What changed

- `/rota` (Rota in the navigation): a home's rotas, each as an icon and a word; starting a rota.
- `/rota/locations/{id}/templates`: shift templates (24-hour UK times, next-day ends said) and
  patterns, made and archived.
- `/rota/{id}`: the builder by day (`hb-long-list`), shifts from a template or a pattern, and for
  each open shift a picker named with its day and times; the rostering rule's answer in words,
  focused when it arrives; an override, for holders of `scheduling.rota.approve` only, with a
  justification and a tick for the blockers listed, sending exactly the keys shown; a missing right
  to work, or a member who is not active, said in words with no override; assigned shifts read
  "Assigned", never a tick; cancel and take-off sheets that name the shift.
- `/rota/{id}/check`: the staffing comparison per date and period against the organisation's own
  scale, said on the page not to be a Harbour score, with the API's word and an icon, the figures,
  source, notice, warnings, open shifts and the method; working time findings with their
  conditions, limits and notes as advice; eligibility again. Publishing with each period ticked by
  name and the warnings read; a summary that takes focus and links to the first box to tick.
- `/my-shifts`: the member's published shifts for six weeks.
- `/settings/dependency` and `/settings/dependency/{id}`: the organisation's scales, made with an
  editor (periods, categories with care minutes, skill mix, review interval) whose problems are
  shown at each field and whose add and remove buttons move focus; drafts approved by someone
  else after a confirmation; discard and archive with a reason.
- A person's Dependency tab: the record in force with one-to-one hours, every record (a corrected
  one struck through), and recording a review or correction that carries one-to-one hours forward.
- API: `GET /v1/locations/{id}/rota-workers` (scheduling.rota.manage reaching the home; ids,
  names and job titles; a made-up home not found; audited with the count), OpenAPI and the client
  regenerated; rota and dependency types exported from contracts.
- Strings in en-GB (and cy, marked untranslated). Hazard log HZ-123 and HZ-124, feature register,
  records of processing.

## Found, not fixed here

- The demo staff have no staff file, so the journey shows the right-to-work refusal rather than
  an override on screen (H-964). One-to-one hours are carried forward, not edited (H-962). Swaps,
  open-shift offers and agency bookings come later (H-969).

## Human actions logged

- H-960 to H-969.

## Tests

- Web unit tests 1499 passed (including `lib/rota.test.ts` and `lib/dependency.test.ts`); i18n 48.
- API `rota.test.ts` with the picker (a home of the same organisation and a made-up one refused,
  audited); API suite 1460 passed before the review fixes.
- Playwright `e2e/rota.spec.ts` 3 passed (axe in light and dark on every screen and the cancel
  sheet), on two fresh local databases.
- Reviewers: accessibility (unique names per shift, per-field errors in the scale editor and the
  pattern form, focus after add and remove, announcements, confirmation before approving, "Keep"
  buttons, next-day times, link targets), clinical safety (one-to-one hours kept, "Assigned" not a
  tick, not-active wording, working time detail, deterministic acknowledgement steps in the
  journey, hazard log) and security (audit, a made-up home, same-organisation test) findings fixed.
