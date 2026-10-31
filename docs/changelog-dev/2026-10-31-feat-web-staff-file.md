# Staff file, compliance, sponsor and privacy screens

Branch `feat/web-staff-file` (Phase 2 slice 56; WORK-002, WORK-003, WORK-011).

## What changed

- Staff files (`/staff`): every file's state as an icon and a word, a new file for current staff
  (never oneself), and each record's Schedule 3 checks with a form per recordable kind and the
  profile form, never on one's own file.
- Sponsored workers (`/staff/sponsorship`): HR only and never one's own record; visa, salary,
  Appendix D, absence warnings and report clocks, with forms to record and change the record,
  absences and changes, mark a change reported and end sponsorship.
- My privacy (`/settings/privacy`, account menu): acknowledge the staff privacy notice in force and
  decide on each optional image use; the notice version is set on the data protection page.
- API: `GET /v1/workforce/staff-members`, the staff picker for HR forms (current staff with a staff
  role in force, name and job title only); creating a staff file or sponsor record for anyone else
  is refused. OpenAPI and the client regenerated.
- Accessibility review: a message per field, saved states said by the page with focus on its
  heading, forms opened from an `aria-expanded` button, one-button consent changes that say what
  they do, explicit ICU values. Security review: the picker's role-in-force predicates and portal
  exclusion, guarded server actions, no needless audited denials.
- Copy in en-GB, Welsh marked untranslated; workforce.md section 13; human actions H-940 to H-949.

## Found, not fixed here

- Inside a closed `<details>`, colour transitions after a theme switch never finish, so the axe
  helper's animation wait hangs; these screens avoid it by mounting forms only once opened. Other
  screens with forms in `<details>` may hit it in dark-mode journeys.
- Employment history, DBS risk assessment and HR-only document forms, LDSS screens and a link to
  the notice text are listed in workforce.md section 13.4.
