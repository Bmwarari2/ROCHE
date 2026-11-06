# Workforce screens: recruitment, induction, leavers and casework (WORK-001, WORK-004, WORK-010, WORK-013, plan slice 58)

Branch `feat/web-workforce-people`, cut from `feat/work-onboarding-leavers` (slices 23, 29 and 39).

## What changed

- Web screens under `/workforce`, on the existing API:
  - recruitment: job templates, vacancies, applications, shortlisting, values-based interviews, offers, and equality counts once a vacancy closes;
  - staff: the staff list, each member's induction (checklist, plan, shadow shifts, probation, the Care Certificate) and leaving (checklist, end access now with confirmation and step-up, exit interview, references);
  - employee relations: my cases, and each case for its members, every action offered only to the part that may take it.
- One generic form (`WorkforceForm`) used by every screen. After a save the page opens again and says what was done, with focus on its heading. The form is cleared, so an append-only entry is not sent twice. Refusals are said at each field, and step-up and a verified second factor are asked for in the step's own words.
- Navigation: "Vacancies", "Staff" and "Employee relations". The last is offered only to holders of `workforce.casework.manage` (the silo, ADR-0089), and never shows whether anyone is on a case.
- API:
  - `GET /v1/workforce/colleagues` lists colleagues by name and job title. A colleague holds a role in force, never a portal role or one for inspectors, visiting professionals or agency workers (`NON_STAFF_ROLE_KEYS`). Naming a case member or an interview panel now refuses anyone else. The read is audited without names.
  - Cases carry `subjectName` and `staff`, for their active members only.
- Strings: en-GB catalogue entries for every workforce code, checked against the domain's code lists by a table-driven test. Welsh entries are marked untranslated. Dates are dd/mm/yyyy and times 24-hour.
- Spec: [workforce.md](../specs/workforce.md) section 5 (screens) and section 11 (known gaps). Records of processing (staff user account row) and the feature register are updated.

## Human actions logged

- H-930 to H-939: trying the screens with providers; the casework navigation for members without the role; colleagues for case managers; who counts as a colleague; a demo caseworker for the journeys; a screen reader check; the copy; Welsh.

## Tests

- `apps/web/src/lib/workforce.test.ts` (60: every code has words, who is offered which screen, status chips, helpers).
- `apps/web/e2e/workforce.spec.ts` (6 journeys, axe on every state).
- `apps/api/test/casework.test.ts`: colleagues, with non-staff and roles not in force left out and refused, audit without names, and nothing told to a non-member.
- Also re-run: the web unit suite, the i18n catalogue tests, and the recruitment, induction and route-gate API tests.

## Review rounds

- Accessibility reviewer. Fixed:
  - success was lost when a form unmounted; the form now reopens the page with a status and focus;
  - the form never reset;
  - destructive steps had no confirmation;
  - error copy built from labels;
  - a heading skip;
  - repeated button names;
  - lists joined with commas;
  - full stops on done messages;
  - empty states with no next step;
  - the nav label differed from the page title;
  - no email or phone input types;
  - a double disable.
  The journeys also found that a field named `title` shared its form heading's id, so it had no label; fixed.
- Security reviewer: no critical or high findings. Fixed:
  - non-staff accounts and roles not in force reached the colleagues list (M1, M2), now also refused when naming;
  - the read was not audited;
  - an MFA refusal showed a generic error;
  - the step-up words were wrong for ending access.
  The navigation entry for members without the role is logged (H-933).
