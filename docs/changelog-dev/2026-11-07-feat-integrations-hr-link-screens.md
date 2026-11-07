# 2026-11-07 feat/integrations-hr-link-screens: screens and guides for the Thapsus-HR link (slice 90)

INTG-014; HZ-133, HZ-140. Built on slice 89 (feat/integrations-hr-link-pay).

## What changed

- **Web: one settings page**, `/settings/hr-link` ("HR platform link" in the menu, shown with the
  flag on to holders of the link's permissions):
  - status and sync health, with the staleness note, **Check the link** and **Sync now**;
  - connect (step-up), owners and the out-of-date limit, and disconnect after a confirmation;
  - location mapping and the match review queue (confirm or reject);
  - what was sent to the HR platform;
  - pay: the route to payroll, a change from a later pay period, and pay codes (for pay approvers);
  - absence copies to release, listed from the HR platform's list read again.
- **"Managed in the HR platform"** (icon and words) on absences copied from the HR platform and on
  pay runs paid through it; the API's `managed_in_thapsus_hr` refusal reads the same.
- **API:**
  - `GET /v1/integrations/hr-link/absences/held` lists what a release would end, changing nothing;
  - `GET /v1/integrations/hr-link` returns the pay settings;
  - `AbsenceItem.source` and `PayRunItem.payRoute`;
  - a pay run for a period set for the HR platform is not drafted while the link is down unless the
    person confirms the export (`confirmExport`, audited);
  - pay approvers are told on the scheduled sync when the flag is off with locked pay unsent;
  - a changed employee's rate is read on `employee.changed`;
  - rates the HR platform stops listing for an employee are retired (only after a clean read), as
    are pay periods no pay run uses;
  - a shift cancellation answered not found is done, never retried every run.
- **Guides** for the Registered Manager and owner: linking, paying through the HR platform and
  releasing absence copies.
- Playwright with axe in light and dark: refused, not turned on, absences unchanged.

## Reviews

- Security reviewer, request changes (fixed): the held list needs a fresh step-up, is limited to 6
  a minute per person and audited; confirming the export needs a pay approver with step-up and is
  audited only when it overrides, with the intended route; rates retired only after a whole clean
  read and only while Thapsus-HR owns them; a not-found cancellation is done only when Thapsus-HR
  had acknowledged the shift (otherwise raised for review).
- Clinical safety reviewer, request changes (fixed): a rate a past period's correction needs is
  never retired; the "link down" refusal is explained in the web with a confirm for pay approvers;
  the guides say what the screens do (pay run label, staff file still to come, held list while
  connected or disconnected); each held copy shows whose it is.
- Accessibility reviewer, request changes (fixed): the linked states (status, matches, deliveries,
  pay, release, connect, owners, locations, the disconnect sheet, the managed label) are rendered
  with linked data and checked with axe in light and dark in `HrLinkForms.test.tsx` (jsdom, so no
  contrast check; Storybook here loads `@harbour/ui` only, which gained a `ManagedElsewhere`
  `StatusChip` story for contrast); focus kept on check and sync; wording, pending labels, `<time>`
  dates, the date hint; typed pay values kept across a step-up.

- Second passes: security approve; accessibility approve; clinical asked for tests of the export
  confirmation (drafter and stale step-up refused, intended route audited), the unacknowledged
  not-found cancellation and the held list's step-up, limit and audit (added), and the hazard row
  corrected.

## Left

- The staff file has no web screen yet: its "Managed in the HR platform" label and the
  leaving-date withdrawal form come with it (slice 56 web).
- The end-to-end environment cannot connect a link (the demo seed does not turn the flag on), so
  the linked screens are covered by unit and API tests only.
- Welsh translations of the new strings.
- A browser journey with axe over the linked screens once a seed or mock can turn the link on (the
  jsdom axe tests cannot check contrast or target size).
- The "Pay this period through the payroll export" button drops focus while sending.
- Zod at the web server-action boundary for the link's actions: zod is not a dependency of the web
  app; the actions use strict checks matching the API's limits (`lib/hr-link.ts`, tested), and the
  API validates every field.
- Thapsus-HR's partner pay items and pay read (H-1443).
