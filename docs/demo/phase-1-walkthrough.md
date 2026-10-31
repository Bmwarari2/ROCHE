# Phase 1 walkthrough: Harbour House residential and nursing home

A scripted demonstration of the Phase 1 web screens on `main`, against the local demo seed
(master prompt section 19: "record a scripted walkthrough in docs/demo/ at the end of each
phase"). It takes about 45 minutes. Every person and account in it is invented.

Each step says who to sign in as, what to do and what to point out. The matching user guide is
linked so the audience can follow up. The guides are in [docs/user-guides](../user-guides/README.md).

## Before the demo

### Set up the local demo

Follow [local development](../runbooks/local-development.md), then seed the demo sign-ins:

```sh
pnpm db:reset && pnpm db:migrate && pnpm db:seed
HARBOUR_SEED_DEMO_USERS=1 HARBOUR_DEMO_MFA=off HARBOUR_DEMO_E2E_PASSKEY=1 \
  pnpm --filter @harbour/api seed:users
pnpm --filter @harbour/api dev     # API on http://localhost:4000
pnpm --filter @harbour/web dev     # web on http://localhost:3000
pnpm --filter @harbour/api worker  # optional: jobs (exports, alerts, nightly packs)
```

Local only. `seed:users` refuses to run against anything but a local database.

### Sign-ins

Password for all of them: `correct horse battery staple`.

| Sign in as | Name | Role | Use for |
| --- | --- | --- | --- |
| `carer@example.invalid` | Cat Carer | Care or support worker, assigned to Ada, Ben and Cara | Notes, charts, body map, round, handover, raising an incident |
| `nurse@example.invalid` | Nell Nurse | Clinical lead or nurse | Assessments, care plan, risk, resuscitation, hospital transfer, reviews, downtime |
| `manager@example.invalid` | Mo Manager | Registered Manager, Harbour House | Incident review, statutory notifications, break-glass, team, family updates, letters |
| `owner@example.invalid` | Olive Owner | Owner, whole organisation | Export, getting started, DPIA, approving a letter template |
| `relative.example@example.invalid` | Relative Example | Family member, Ada's next of kin | The family updates page |

### MFA and step-up: read this first

- `HARBOUR_DEMO_MFA=off` lets the demo staff open care records with a password alone. **Say so to
  the audience**: in every real organisation, care records need a passkey or an authenticator code.
- Step-up actions still need a second factor used in the last 10 minutes: break-glass, statutory
  notification submission, the downtime pack, inviting a team member, export, DPIA sign-off and
  removing sample data. A password never counts.
- `HARBOUR_DEMO_E2E_PASSKEY=1` gives the manager, owner and family member a passkey whose key is
  public. It works only in the Playwright journeys' virtual authenticator, not for a presenter.
- **For a live demo**, sign in once beforehand as the manager, the owner and the family member, go
  to **Settings**, and set up an authenticator app on a demo phone
  ([guide](../user-guides/all-staff/set-up-a-second-sign-in-step.md)). In the demo, sign in with the
  password and then the code: that counts as step-up for 10 minutes.

### Who is in the home

Harbour House (60 beds, nursing and residential). The people, all invented, with NHS numbers in the
999 range:

| Room | Person | Point to show |
| --- | --- | --- |
| 1 | Ada Example, known as Addie | Severe penicillin allergy; needs information in large print |
| 2 | Ben Sample | No known allergies; communication needs not recorded |
| 3 | Cara Placeholder | Allergies **not recorded**; uses a hearing loop |
| 4 | Dev Fixture | Two allergies, one severe |
| 5 | Elsie Mock, known as Else | Needs a Welsh language interpreter |
| 6 | Frank Dummy | Mild aspirin allergy |

Harbour Mews is a second home with one resident, Una Example, whom the Harbour House staff cannot
see: use her for break-glass. Sam Twin and Sam Twin, also at the Mews, show the same-name warning.

## 1. Signing in and the person record (carer, 5 minutes)

Sign in as **Cat Carer**.

1. Show **Sign in to Harbour**, with **Sign in with a passkey** beside the password.
   ([guide](../user-guides/all-staff/sign-in.md))
2. Go to **Residents**. Point out that Cat sees only the three people assigned to her.
3. Point out the allergy chips: Ada "1 allergy", Ben "No known allergies", Cara
   **"Allergies not recorded"**. Say plainly: not recorded never means none.
4. Open Ada. Point out the header on every tab: photo or initials, preferred name, date of birth,
   NHS number, allergies, **CPR decision not recorded** (nothing is recorded yet), food and drink
   levels, and "Needs information in large print" in words, not just a colour.
   ([guide](../user-guides/care-worker/check-the-person-before-you-act.md))

## 2. Recording care (carer, 8 minutes)

Still as Cat, on Ada's record.

1. **Notes**: write a note, then **Correct this note**. Point out the original stays, struck
   through, with the reason. Nothing is ever deleted.
   ([guide](../user-guides/care-worker/write-a-daily-note.md))
2. **Notes** again: choose **Earlier** with a time 3 hours ago. Point out the **Late entry** flag.
3. **Charts**, **Fluid intake**: record 200 ml. Point out the fluid balance meter and that refused
   drinks are not counted. ([guide](../user-guides/care-worker/record-a-chart-entry.md))
4. **Charts**, **Vital signs**: enter respiration 24, SpO2 95, systolic 105, pulse 115, temperature
   38.5, air, alert. Point out the NEWS2 result: the score, the RCP's response wording, how each
   point was worked out, the published source, who was told, and the organisation's escalation
   policy (CP-07). The score supports judgement and never replaces it.
   ([guide](../user-guides/care-worker/record-vital-signs.md))
5. **Body map**: tap the left knee on the front view and confirm **Right** in words. Point out it is
   refused: the side in words must agree with the drawing. Choose **Left**, type "Bruise", cause not
   known, and save. Point out the form says this raises an incident report task and the
   safeguarding guide for the manager. ([guide](../user-guides/care-worker/mark-the-body-map.md))
6. **Activities and visits**: record a visit with a restriction, and show the reason is required
   (Regulation 9A).

## 3. Round and handover (carer, 5 minutes)

1. Go to **Round**. Point out the floor-by-floor list, the time chips (**Due now**, **Overdue**) and
   **Show only Addie's tasks**. Mark one task **Not done** with a reason.
   ([guide](../user-guides/care-worker/run-a-round.md))
   - If the round is empty, publish Ada's care plan first (step 5) with an action, then come back.
2. Go to **Handover**, choose **Compile this shift's handover**, and open it. Point out the NEWS2
   item, the body map mark and the task not done, compiled from the record.
3. Choose **I have read this handover**. Point out that acknowledging records exactly the items
   shown; anything added later asks to be read again.
   ([guide](../user-guides/care-worker/read-and-acknowledge-the-handover.md))

## 4. An incident and its statutory notifications (carer, then manager, 10 minutes)

1. As Cat, on Ada's record, choose **Record an incident**. Choose "Fall", **Just now**, write what
   happened, answer **Not sure yet** to the head injury question and **No** to the medicines
   question, and answer the emergency services and GP questions. Save.
   ([guide](../user-guides/care-worker/record-an-incident.md))
2. Point out: "Not sure yet" is treated as yes, so Harbour sets urgent medical advice and timed
   observation tasks. Say that the incident page itself does not show these tasks (a gap to fix).
3. Sign out. Sign in as **Mo Manager** with the password and authenticator code.
4. Go to **Incidents** and open the fall. Point out the questions about statutory notifications,
   and that a care worker could not close it. ([guide](../user-guides/registered-manager/answer-notification-questions.md))
5. Choose **Statutory notifications**. Point out the clocks in words: **Overdue for ...**,
   **Due**, **Clock not known**, "Without delay: the clock started ...", and that the page says when
   the clocks were worked out. ([guide](../user-guides/registered-manager/read-notification-clocks.md))
6. Open a notification (record a second incident of "Safeguarding concern" if none is drafted).
   Fill in **Prepare the notification** and choose **Save and mark ready to submit**.
7. Under **Record that it was submitted**, enter an invented reference such as `DEMO-0001` and
   choose **Record as submitted**. Point out: Harbour does not send it to CQC; the manager submits
   on the regulator's portal and records it here. If more than 10 minutes have passed since the
   code, **Confirm it is you** appears: this is step-up.
   ([guide](../user-guides/registered-manager/record-a-notification-as-submitted.md))
8. Back on the incident, **Start the review**, then try to close it. Point out **Before it can close**
   lists what is left. ([guide](../user-guides/registered-manager/review-and-close-an-incident.md))

## 5. Clinical records (nurse, 8 minutes)

Sign in as **Nell Nurse**.

1. **Assessments**, **Run MUST** on Ada. Point out the workings, the BAPEN source, what the result
   raised and the next due date. **Ask the falls questions**: no score, because NICE advises
   against falls prediction scores. ([guide](../user-guides/nurse/run-a-validated-tool.md))
2. **Risk assessments**: add a "Bed rails" assessment. Point out likelihood and severity are the
   assessor's judgement; Harbour only applies the matrix.
3. **Care plan**: start a plan, fill one need with an action, choose **Publish the care plan** and
   record that Addie agreed it. ([guide](../user-guides/nurse/write-and-publish-a-care-plan.md))
4. **Advance care**: record a DNACPR decision by an invented GP. Point out the header changes from
   "CPR decision not recorded" to "Do not attempt CPR" with its source.
   ([guide](../user-guides/nurse/record-a-resuscitation-decision.md))
5. **History**: open the care plan's changes. Point out nothing is deleted.
6. **Consent, capacity and DoLS**: point out "Capacity is assumed for every decision unless an
   assessment of that decision shows otherwise". Say that recording consent, capacity and DoLS is
   not on screen yet. ([guide](../user-guides/care-worker/check-consent-capacity-and-dols.md))
7. **Reviews**: record a change in need ("Fall"). Point out the care plan review comes forward.
8. **Hospital** on Frank: send him to an invented hospital, print the transfer pack PDF, and record
   the hand-over. Point out missing sections print as "not recorded", never blank, and the
   instruction to check name, date of birth and NHS number against the person. Record the return
   and show **Checks on return**. ([guide](../user-guides/senior-carer/send-someone-to-hospital.md))

## 6. Downtime (nurse or manager, 5 minutes)

Sign in as **Mo Manager** with a code, for step-up.

1. Go to **Downtime**, **Open the pack**. Point out **In date**, **Information as at** and
   **Use until**, and that the page names no one: people are only on paper.
2. **Download the pack to print (PDF)** and show a page: allergies, resuscitation, food and drink
   levels, communication needs, and "Allergies not recorded. Do not assume there are none." for Cara.
   ([guide](../user-guides/senior-carer/print-the-downtime-pack.md))
3. **Declare an outage** ("Network down", started 30 minutes ago).
4. As **Cat Carer**, write a note on Ben choosing **From a paper downtime form**, with the outage and
   the paper time. Point out **Entered from a paper record**.
   ([guide](../user-guides/care-worker/enter-paper-records-after-an-outage.md))
5. As Mo, **Close the outage**, then show **Reconcile the paper records**. Point out that someone who
   entered paper records cannot reconcile them. ([guide](../user-guides/registered-manager/reconcile-an-outage.md))

## 7. Family updates and letters (manager, owner, family, 5 minutes)

1. As **Mo Manager**, on Ada's **Family updates**, write an update from today's note, **Preview the
   update** and **Publish the update**. Point out: plain words only, no other residents' names, and
   the feed is never used for falls or hospital news.
   ([guide](../user-guides/senior-carer/publish-a-family-update.md))
2. Sign in as **Relative Example** (with the authenticator code). Show **Updates**: "These are
   everyday updates. They are not the full care record. The home will phone you about anything
   important." ([guide](../user-guides/family-member/read-updates.md))
   - Whether the update shows depends on Ada's sharing decisions, which have no screen yet. If the
     feed is empty, say so.
3. As **Mo**, go to **Letters**, **New template**, write a general letter and **Save draft**. Point
   out Mo cannot approve his own draft. Sign in as **Olive Owner** and **Approve this draft**.
   ([guide](../user-guides/registered-manager/write-a-letter-template.md))
4. As Mo, on Ada's **Letters** tab, make a letter, preview, tick the check and **Make the letter**.

## 8. Access and data protection (manager and owner, 6 minutes)

1. As **Olive Owner** (who sees the whole organisation), go to **Search** and search "Sam Twin".
   Point out the same-name warning "check the photo and date of birth before opening".
   ([guide](../user-guides/all-staff/search-for-a-person.md))
2. As **Mo**, search "Una Example": nothing is found, because she lives at Harbour Mews. Choose
   **Search outside your access** and point out the reason, the 5-a-day limit, and that results
   show who the person is but never where they live.
3. Open Una Example with **Open a record outside your access**: type a reason of 20 characters or
   more. Point out the record opens for reading only and the Registered Manager and data
   protection lead are told. ([guide](../user-guides/registered-manager/open-a-record-with-break-glass.md))
4. Build this week's break-glass report:
   `pnpm --filter @harbour/api break-glass-report:run --this-week`. As Olive, open
   **Break-glass report**: the opening is counted. Point out a person cannot review a report that
   counts their own use, and that times and typed reasons are not shown yet.
   ([guide](../user-guides/registered-manager/review-the-weekly-break-glass-report.md))
5. As **Olive Owner**: **Data export**, **Ask for an export**, then run
   `pnpm --filter @harbour/api exports:run` (unless the worker is running) and **Download**. Point out
   it downloads once and the file is deleted. ([guide](../user-guides/owner/request-a-full-export.md))
6. **Getting started**: show the checklist worked out from the records.
   ([guide](../user-guides/owner/work-through-getting-started.md))
7. **Data protection**: show the DPIA states and the sign-off with a typed name, tied to the version
   fingerprint. ([guide](../user-guides/data-protection-lead/prepare-and-sign-the-dpia.md))
8. **Team**: invite an invented colleague (`new.starter@example.invalid`). Point out one role per
   invitation and step-up. ([guide](../user-guides/registered-manager/invite-a-team-member.md))

Sample data mode cannot be shown in the demo organisation, because it already has real (invented)
people. Sign in as `starter.owner@example.invalid` (organisation Starter Example Care) to show
**Load sample data** and **Remove sample data**.

## What Phase 1 does not show yet

Say these plainly if asked. They are API-only, mobile-only or not built:

- Adding a person, editing details, allergies and photos; About Me; pre-admission, admission,
  rooms and property; discharge, transfer and death; sharing decisions.
- Recording consent, capacity, best interests and DoLS on screen.
- Documents, tasks, retention and legal holds; duty of candour, the medical examiner pack and
  investigations; composing an evidence pack and the inspector's page; the statement of purpose.
- Role dashboards and white-label branding.
- The mobile app's Care mode, offline recording and the sync banner (in development, not released).

## After the demo

`pnpm db:reset && pnpm db:migrate && pnpm db:seed` and seed the sign-ins again to start fresh.
