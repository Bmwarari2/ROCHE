# Web usability gaps found while writing the Phase 1 user guides

Branch `fix/web-ux-gaps-from-guides`. The gaps were listed when #128 (the user guides) was written;
this fixes the ones that are web-only and need no API change.

## What changed

- **Checks after a fall on the incident page** (HZ-027): the post-fall care tasks the classifier
  sets are listed under "Checks after the fall", urgent medical advice first with an "Urgent" chip
  (icon and word) and wording that says why; due and until times in `<time>`; left out once the
  incident is closed (`postFallChecks` in `apps/web/src/lib/incidents.ts`). The incident form's
  injuries hint says marks on the body map are not linked to the incident yet, so describe them in
  the incident too.
- **Who checks the law when notifications are not checked yet** (HZ-013): someone who manages
  incidents but cannot submit is no longer told to "ask a nurse"; they check the law themselves and
  tell the Registered Manager, who submits. Anyone else tells the nurse in charge or the Registered
  Manager. "The questions are not on this page yet" became "The questions are not shown to you
  here", which no longer suggests they will appear later.
- **Body map**: the pressure ulcer category, the medical device question and the bruise question
  are marked required and asked for in words before sending (the API refused them before); after a
  mark that raises the incident report and safeguarding guide tasks (the domain's `markTriggers`),
  the saved message says so and asks the carer to tell the nurse in charge.
- **Downtime pack hint**: says the passkey or authenticator code is asked for, not "you may be
  asked to sign in again", and to shred the old pack when a new one is put out.
- **Sign-in with a backup code**: the second step takes a 6-digit code or one of the backup codes
  (`readSignInCode`, Better Auth's `verifyBackupCode`); the label and hint say so. Setting up the
  app keeps its own 6-digit message.
- **Break-glass**: opening a record asks "Why you need this record" (the same reasons as the
  break-glass search) and sends the reason code, so the weekly report no longer counts every web
  opening as "No reason chosen"; the panel says access lasts one hour.
- **Codes on screen in words**: the onboarding checklist names settings and record classes in
  words (`settingName`, with care initialisms in capitals) instead of the key in monospace, in the
  text and the buttons' accessible names; the reviews tab says the dates are "worked out from your
  organisation's settings" with each setting in words, not "Rate table: key"; letters and templates
  list the personal details used by the merge field's name (`mergeFieldNames`).
- **Email templates**: not offered on the person's Letters tab while Harbour cannot send email,
  with a line saying why, instead of a "Send the email" button that always failed.
- **Sidebar**: "Letters" is now "Letter templates", since the record tab "Letters" makes letters.
- **Docs**: the user guides for these screens, the Phase 1 walkthrough, the Phase 1 gate report
  (user guides done) and STATUS (the open gaps below).

## Not fixed here (each needs more than a web change)

- Acknowledging an overdue statutory notification alert stops its escalation (API).
- The inspector's link has no page to enter the code (a cross-origin cookie or proxy decision).
- Body map marks are not linked to an incident (API).
- `operations.downtime.read` is not marked step-up in the permission catalogue (domain).
- The break-glass search alert links to a page that does not exist, and "data protection lead"
  means two different things (API).
- The DPIA's typed name is not checked against the account (domain and API).
- Acting-up grants have no screen, so a deputy cannot record a submission (its own slice).
- Each setting on the onboarding checklist would read better with a name of its own in the
  catalogue; the words are made from the key for now.

## Human actions logged

- None.

## Tests

- Unit tests: `apps/web/src/lib/incidents.test.ts` (post-fall checks, the hint wording),
  `IncidentNotifications.test.tsx`, `onboarding.test.ts` (`settingName`), `letters.test.ts`
  (merge field names, email templates left out), `sign-in-code.test.ts`; the whole web suite,
  lint and typecheck (see the pull request).
- E2E journeys updated for the new names and fields (`letter-templates`, `letters`, `onboarding`,
  `reviews`, `break-glass`, `break-glass-report`); they need the full stack and were not run here,
  so CI runs them with axe.
