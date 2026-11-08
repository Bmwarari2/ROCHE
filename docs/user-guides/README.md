# User guides

Short, task-based guides for the people who use Thapsus Care, one task per guide. They describe what
the screens on `main` do now. Where a feature has no screen yet, the guide says so rather than
inventing steps. The definition of done (master prompt section 19) needs a user guide for every
feature-register row, and a user guide per role (section 19, definition of complete, item 5).

## Find your guides

| Role folder | Built-in roles it is for |
| --- | --- |
| [All staff](all-staff/README.md) | Everyone: signing in, search, history |
| [Care worker](care-worker/README.md) | Care or support worker, agency or bank worker |
| [Senior carer or team leader](senior-carer/README.md) | Team leader or senior carer |
| [Nurse](nurse/README.md) | Clinical lead or nurse |
| [Registered Manager](registered-manager/README.md) | Registered Manager, deputy manager |
| [Owner](owner/README.md) | Owner (founder, director or Nominated Individual) |
| [HR lead](hr-lead/README.md) | HR, recruitment or training lead; employee relations lead |
| [Data protection lead](data-protection-lead/README.md) | Quality and compliance lead, or the person named as data protection lead |
| [Family member](family-member/README.md) | Family or representative |
| [Inspector](inspector/README.md) | Inspector or auditor |

Each role's index links every guide that role uses. A guide lives in the folder of the most junior
role that does the task, and the other roles link to it; for example the Registered Manager's index
links the care worker's incident guide.

## How to write a guide

- One task per file, named for the task: `record-an-incident.md`. The title starts "How to".
- Under the title: one line on what the task is for, **Who can do this** (in roles, not permission
  keys) and **Register row** or **Register rows** with the IDs it covers.
- Numbered steps under `## Steps`. Button, heading and field names in bold, copied exactly from
  `packages/i18n/src/messages/en-GB.json`.
- Then `## Good to know` or `## Important`: safety-critical behaviour in plain words (what "not
  recorded" means, step-up, who cannot do what), and anything still to come.
- Follow [packages/ui/CONTENT.md](../../packages/ui/CONTENT.md): British English, sentence case,
  plain English a care worker on a night shift can follow, dd/mm/yyyy and the 24-hour clock, no
  emoji. Invented people only (Ada Example).
- When a screen changes, update its guide in the same pull request. Add new guides to the role
  indexes and the table below, and link the guide from the register's user docs column.

## Register rows and their guides

Phase 1 rows (and the Phase 0 rows with Phase 1 screens), and the Phase 2 medicines (slice 81),
workforce and scheduling (slice 82) and safety, quality and platform (slice 83) rows, that have a
guide, with the Phase 1 screens that merged after the first guides (the Phase 2 gaps pass). The
register's user docs column links the same guides.

| Row | Guides |
| --- | --- |
| PLAT-002 | [Set your organisation's branding](owner/set-your-organisations-branding.md) |
| PLAT-004 | [Sign in](all-staff/sign-in.md), [Accept an invitation](all-staff/accept-an-invitation.md), [Set up a passkey or authenticator app](all-staff/set-up-a-second-sign-in-step.md), [Invite a team member](registered-manager/invite-a-team-member.md), [Suspend, reinstate or end a team member's membership](registered-manager/suspend-reinstate-or-end-a-membership.md) |
| PLAT-005 | [Turn on single sign-on](owner/turn-on-single-sign-on.md) (no screen yet) |
| PLAT-006 | [Open a record with break-glass](registered-manager/open-a-record-with-break-glass.md), [Review the weekly break-glass report](registered-manager/review-the-weekly-break-glass-report.md) |
| PLAT-007 | [See the history of a record](all-staff/view-a-records-history.md) |
| PLAT-009 | [Read and sign an organisation document](all-staff/read-and-sign-an-organisation-document.md), [Add an organisation document or a new version](registered-manager/add-an-organisation-document.md) |
| PLAT-011 | [Work through your tasks](care-worker/work-through-your-tasks.md), [Create a task](senior-carer/create-a-task.md), [Work through approvals](senior-carer/work-through-approvals.md) |
| PLAT-013 | [Search for a person](all-staff/search-for-a-person.md), [Open a record with break-glass](registered-manager/open-a-record-with-break-glass.md) |
| PLAT-014 | [Import people from another system](owner/import-people-from-another-system.md), [Undo an import](owner/undo-an-import.md), [Import medicines, care plans or staff file checks](owner/import-medicines-care-plans-or-staff-file-checks.md) |
| PLAT-015 | [Get a full export](owner/request-a-full-export.md) |
| PLAT-018 | [Work through getting started](owner/work-through-getting-started.md) |
| PLAT-022 | [Handle a data rights request](data-protection-lead/handle-a-data-rights-request.md), [Find and review the records for a data rights request](data-protection-lead/find-and-review-the-records-for-a-request.md), [Send the response to a data rights request](data-protection-lead/send-the-response-to-a-data-rights-request.md), [Handle a request to erase, correct or move information](data-protection-lead/handle-an-erasure-correction-or-portability-request.md), [Record and handle a data breach](data-protection-lead/record-a-data-breach.md), [Acknowledge a breach notice from Thapsus](data-protection-lead/acknowledge-a-breach-notice-from-thapsus.md), [Handle a data protection complaint](data-protection-lead/handle-a-data-protection-complaint.md) |
| PLAT-023 | [Prepare and sign the DPIA](data-protection-lead/prepare-and-sign-the-dpia.md) |
| PEOP-001 | [Check the person's details](care-worker/check-the-person-before-you-act.md), [Change a person's details and contacts](registered-manager/change-a-persons-details-and-contacts.md) |
| PEOP-002 | [Check the person's details](care-worker/check-the-person-before-you-act.md), [Change a person's details and contacts](registered-manager/change-a-persons-details-and-contacts.md) |
| PEOP-003 | [Write About me](nurse/write-about-me.md) |
| PEOP-005 | [Record an enquiry and start the pre-admission assessment](registered-manager/record-an-enquiry.md), [Fill in a pre-admission assessment](nurse/fill-in-a-pre-admission-assessment.md), [Record a decision to admit](registered-manager/record-a-decision-to-admit.md) |
| PEOP-007 | [Record an admission and a room](registered-manager/record-an-admission-and-a-room.md), [Record a person's property and keys](senior-carer/record-property-and-keys.md) |
| PEOP-008 | [Record a review](nurse/record-a-review.md) |
| PEOP-009 | [Send someone to hospital](senior-carer/send-someone-to-hospital.md) |
| PEOP-010 | [Record a death](senior-carer/record-a-death.md), [Discharge a person or transfer them to another provider](registered-manager/discharge-or-transfer-a-person.md) |
| PEOP-013 | [Record a sharing decision](registered-manager/record-a-sharing-decision.md) |
| CARE-001 | [Write and publish a care plan](nurse/write-and-publish-a-care-plan.md) |
| CARE-002 | [Add a risk assessment](nurse/add-a-risk-assessment.md) |
| CARE-003 | [Run a validated tool](nurse/run-a-validated-tool.md) |
| CARE-006 | [Run a validated tool (falls questions)](nurse/run-a-validated-tool.md) |
| CARE-007 | [Record vital signs and NEWS2](care-worker/record-vital-signs.md) |
| CARE-009 | [Write a daily note](care-worker/write-a-daily-note.md) |
| CARE-010 | [Record a chart entry](care-worker/record-a-chart-entry.md), [Set food and drink levels](nurse/set-food-and-drink-levels.md) |
| CARE-012 | [Mark the body map](care-worker/mark-the-body-map.md) |
| CARE-013 | [Do a round](care-worker/run-a-round.md), [Read and acknowledge the handover](care-worker/read-and-acknowledge-the-handover.md) |
| CARE-014 | [Record an activity or visit](care-worker/record-an-activity-or-visit.md) |
| CARE-015 | [Record a resuscitation decision](nurse/record-a-resuscitation-decision.md), [Check the person's details](care-worker/check-the-person-before-you-act.md) |
| CARE-021 | [Check consent, capacity and DoLS](care-worker/check-consent-capacity-and-dols.md) (reading only: no web forms yet) |
| CARE-022 | [Check consent, capacity and DoLS](care-worker/check-consent-capacity-and-dols.md) (reading only: no web forms yet) |
| SAFE-001 | [Record an incident](care-worker/record-an-incident.md), [Review and close an incident](registered-manager/review-and-close-an-incident.md), [Record a missing person](care-worker/record-a-missing-person.md) |
| SAFE-002 | [Answer the notification questions](registered-manager/answer-notification-questions.md), [Read the notification clocks](registered-manager/read-notification-clocks.md), [Record a notification as submitted](registered-manager/record-a-notification-as-submitted.md) |
| SAFE-003 | [Prepare a statutory notification](registered-manager/prepare-a-statutory-notification.md), [Record a notification as submitted](registered-manager/record-a-notification-as-submitted.md) |
| SAFE-004 | [Prepare a statutory notification](registered-manager/prepare-a-statutory-notification.md), [Read the notification clocks](registered-manager/read-notification-clocks.md) |
| SAFE-005 | [Prepare a statutory notification](registered-manager/prepare-a-statutory-notification.md), [Read the notification clocks](registered-manager/read-notification-clocks.md) |
| SAFE-006 | [Raise a safeguarding concern](care-worker/raise-a-safeguarding-concern.md), [Check a person's safeguarding measures](care-worker/check-safeguarding-measures.md), [Run the safeguarding log](registered-manager/run-the-safeguarding-log.md) |
| SAFE-007 | [Keep a duty of candour record](nurse/keep-a-duty-of-candour-record.md) |
| SAFE-008 | [Follow up after a death](registered-manager/follow-up-after-a-death.md) |
| SAFE-009 | [Record an incident (after a fall)](care-worker/record-an-incident.md), [Mark the body map](care-worker/mark-the-body-map.md) |
| SAFE-010 | [Record an incident investigation](nurse/record-an-incident-investigation.md), [Read incident trends](care-worker/read-incident-trends.md) |
| SAFE-011 | [Handle a complaint](registered-manager/handle-a-complaint.md), [Record a compliment](registered-manager/record-a-compliment.md) |
| SAFE-012 | [Raise a speak-up concern](all-staff/raise-a-speak-up-concern.md), [Speak up anonymously](all-staff/speak-up-anonymously.md), [Handle speak-up cases](all-staff/handle-speak-up-cases.md) |
| SAFE-014 | [Record a death](senior-carer/record-a-death.md), [Follow up after a death](registered-manager/follow-up-after-a-death.md), [Keep a death record](nurse/keep-a-death-record.md), [Record a mortality review](nurse/record-a-mortality-review.md) |
| SAFE-015 | [Record a missing person](care-worker/record-a-missing-person.md), [Close a missing person episode](nurse/close-a-missing-person-episode.md), [Keep a missing person's timeline](care-worker/keep-a-missing-person-timeline.md), [Write a Herbert Protocol profile](nurse/write-a-herbert-protocol-profile.md) |
| QUAL-001 | [Read the compliance framework and map its statements](registered-manager/map-the-compliance-framework.md) |
| QUAL-002 | [Read the compliance framework and map its statements](registered-manager/map-the-compliance-framework.md), [Tag a record as evidence](registered-manager/tag-a-record-as-evidence.md), [Check evidence coverage and its gaps](registered-manager/check-evidence-coverage.md) |
| QUAL-003 | [Compose and release an evidence pack](registered-manager/compose-and-release-an-evidence-pack.md), [Open an evidence pack](inspector/open-an-evidence-pack.md) |
| QUAL-004 | [Add, schedule and retire an audit template](registered-manager/set-up-an-audit-template.md), [Carry out an audit or mock inspection](registered-manager/carry-out-an-audit.md) |
| QUAL-005 | [Read the quality dashboard](registered-manager/read-the-quality-dashboard.md), [Set indicator targets](registered-manager/set-indicator-targets.md) |
| QUAL-006 | [Copy the PIR figures](registered-manager/copy-the-pir-figures.md) |
| QUAL-008 | [Read and sign a policy](all-staff/read-and-sign-a-policy.md), [Write and publish a policy](registered-manager/write-and-publish-a-policy.md), [Check who has read and signed a policy](registered-manager/check-who-has-signed-a-policy.md), [Retire a policy](registered-manager/retire-a-policy.md) |
| QUAL-009 | [Update the statement of purpose](registered-manager/update-the-statement-of-purpose.md) |
| QUAL-012 | [Track DSPT assertions and their evidence](data-protection-lead/track-dspt-assertions-and-evidence.md), [Record a DSPT submission](data-protection-lead/record-a-dspt-submission.md), [Record a Cyber Essentials certificate or ICO registration](data-protection-lead/record-a-certificate-or-registration.md) |
| INSI-001 | [Read your home page](all-staff/read-your-home-page.md) |
| WORK-011 | [Handle a data rights request](data-protection-lead/handle-a-data-rights-request.md), [Find and review the records for a data rights request](data-protection-lead/find-and-review-the-records-for-a-request.md), [Export an employee relations case](hr-lead/export-an-employee-relations-case.md), [Read the staff privacy notice and choose how your photo is used](care-worker/check-your-privacy-choices.md), [Record a sponsored worker](hr-lead/record-a-sponsored-worker.md), [Set the staff privacy notice](owner/set-the-staff-privacy-notice.md) |
| OPS-028 | [Print the downtime pack](senior-carer/print-the-downtime-pack.md), [Declare and close an outage](senior-carer/declare-and-close-an-outage.md), [Enter paper records](care-worker/enter-paper-records-after-an-outage.md), [Reconcile an outage](registered-manager/reconcile-an-outage.md) |
| COMMS-001 | [Publish a family update](senior-carer/publish-a-family-update.md), [Read updates from the home](family-member/read-updates.md) |
| COMMS-006 | [Read and acknowledge the handover](care-worker/read-and-acknowledge-the-handover.md) |
| COMMS-007 | [Write a letter template](registered-manager/write-a-letter-template.md), [Make a letter](registered-manager/make-a-letter.md) |
| MEDS-001 | [Add a medicine to the MAR](nurse/add-a-medicine-to-the-mar.md), [Reconcile medicines](nurse/reconcile-medicines.md), [Second-check a medicine](nurse/second-check-a-medicine.md), [Stop a medicine](nurse/stop-a-medicine.md) |
| MEDS-002 | [Give a when-required (PRN) medicine in the browser](care-worker/give-a-when-required-medicine-in-the-browser.md), [Give medicines in the browser round](care-worker/give-medicines-in-the-browser-round.md) |
| MEDS-003 | [Give a when-required (PRN) medicine in the browser](care-worker/give-a-when-required-medicine-in-the-browser.md), [Read the medicines reports](registered-manager/read-the-medicines-reports.md) |
| MEDS-004 | [Give medicines in the browser round](care-worker/give-medicines-in-the-browser-round.md) |
| MEDS-005 | [Correct a controlled drugs register entry](nurse/correct-a-controlled-drugs-register-entry.md), [Count controlled drugs stock](nurse/count-controlled-drugs-stock.md), [Record a controlled drug received, returned, disposed of or destroyed](nurse/record-a-controlled-drug-movement.md), [Sign as a controlled drugs witness in the browser](care-worker/sign-as-a-controlled-drugs-witness.md) |
| MEDS-007 | [Add a homely remedy protocol](nurse/add-a-homely-remedy-protocol.md), [Change or withdraw a homely remedy protocol](nurse/change-or-withdraw-a-homely-remedy-protocol.md), [Give a homely remedy](care-worker/give-a-homely-remedy.md) |
| MEDS-008 | [Add a medicines fridge or room](nurse/add-a-medicines-fridge-or-room.md), [Dispose of medicines with a witness](nurse/dispose-of-medicines-with-a-witness.md), [Order medicines for the next cycle](nurse/order-medicines-for-the-next-cycle.md), [Receive, return and count medicines stock](nurse/receive-return-and-count-medicines-stock.md), [Record a medicines fridge or room temperature](care-worker/record-a-medicines-fridge-or-room-temperature.md) |
| MEDS-012 | [Add medication error details to an incident](care-worker/add-medication-error-details-to-an-incident.md), [Read the medicines reports](registered-manager/read-the-medicines-reports.md) |
| MEDS-013 | [Book and record a medication review](nurse/book-and-record-a-medication-review.md), [Check the medication review tracker](registered-manager/check-the-medication-review-tracker.md), [Read the medicines reports](registered-manager/read-the-medicines-reports.md) |
| MEDS-014 | [Print a controlled drugs register page](nurse/print-a-controlled-drugs-register-page.md), [Print the MAR chart](care-worker/print-the-mar-chart.md) |
| CARE-004 | [Check and publish a rota](registered-manager/check-and-publish-a-rota.md), [Record a dependency category](senior-carer/record-a-dependency-category.md), [Set up a dependency scale](registered-manager/set-up-a-dependency-scale.md) |
| MOB-007 | [Ask for help while lone working on the phone](care-worker/ask-for-help-while-lone-working-on-the-phone.md), [Check in while lone working on the phone](care-worker/check-in-while-lone-working-on-the-phone.md), [Clock in and out on the phone](care-worker/clock-in-and-out-on-the-phone.md), [Download a training course to the phone](care-worker/download-a-training-course-to-the-phone.md), [See your shifts on the phone](care-worker/see-your-shifts-on-the-phone.md), [Start and finish lone working on the phone](care-worker/start-and-finish-lone-working-on-the-phone.md), [Take a training course offline on the phone](care-worker/take-a-training-course-offline-on-the-phone.md) |
| SCHED-001 | [Build a rota](registered-manager/build-a-rota.md), [Check and publish a rota](registered-manager/check-and-publish-a-rota.md), [Set up a dependency scale](registered-manager/set-up-a-dependency-scale.md) |
| SCHED-002 | [Build a rota](registered-manager/build-a-rota.md), [Check and publish a rota](registered-manager/check-and-publish-a-rota.md), [Check your shifts](care-worker/check-your-shifts.md), [Override the rostering rule](registered-manager/override-the-rostering-rule.md), [See your shifts on the phone](care-worker/see-your-shifts-on-the-phone.md), [Set up shift templates and patterns](registered-manager/set-up-shift-templates-and-patterns.md), [Release absence copies from the HR platform](registered-manager/release-absence-copies.md) |
| SCHED-003 | [Approve timesheets](registered-manager/approve-timesheets.md), [Check and publish a rota](registered-manager/check-and-publish-a-rota.md), [Read working time results](registered-manager/read-working-time-results.md) |
| SCHED-004 | [Approve timesheets](registered-manager/approve-timesheets.md), [Clock in and out on the phone](care-worker/clock-in-and-out-on-the-phone.md), [Clock in and out on the web](care-worker/clock-in-and-out.md) |
| SCHED-005 | [Check your pay](care-worker/check-your-pay.md), [Run and lock a pay run](owner/run-and-lock-a-pay-run.md), [Write and approve a pay rule set](owner/write-and-approve-a-pay-rule-set.md), [Pay staff through the HR platform](registered-manager/set-the-route-to-payroll.md) |
| SCHED-006 | [Check your pay](care-worker/check-your-pay.md), [Run and lock a pay run](owner/run-and-lock-a-pay-run.md) |
| SCHED-007 | [Check your pay](care-worker/check-your-pay.md), [Run and lock a pay run](owner/run-and-lock-a-pay-run.md) |
| SCHED-010 | [Ask for leave](care-worker/ask-for-leave.md), [Decide a leave request](registered-manager/decide-a-leave-request.md) |
| SCHED-011 | [Answer a staff survey](care-worker/answer-a-staff-survey.md), [Keep a wellbeing check-in](care-worker/keep-a-wellbeing-check-in.md), [Read staff survey results](registered-manager/read-staff-survey-results.md), [Run a staff survey](registered-manager/run-a-staff-survey.md), [See what your team shares](registered-manager/see-what-your-team-shares.md), [Thank a colleague](care-worker/thank-a-colleague.md) |
| SCHED-012 | [Ask for help while lone working on the phone](care-worker/ask-for-help-while-lone-working-on-the-phone.md), [Check in while lone working on the phone](care-worker/check-in-while-lone-working-on-the-phone.md), [Check in while working alone on the web](care-worker/check-in-while-working-alone-on-the-web.md), [Name the lone-working on-call route](registered-manager/name-the-lone-working-on-call-route.md), [Respond to a lone-working alarm](senior-carer/respond-to-a-lone-working-alarm.md), [Start and finish lone working on the phone](care-worker/start-and-finish-lone-working-on-the-phone.md) |
| WORK-001 | [Add a job template](hr-lead/add-a-job-template.md), [Add a vacancy](hr-lead/add-a-vacancy.md), [Add an application](hr-lead/add-an-application.md), [Close an application](hr-lead/close-an-application.md), [Make a conditional job offer](hr-lead/make-a-job-offer.md), [Record an interview](hr-lead/record-an-interview.md), [Shortlist an application](hr-lead/shortlist-an-application.md) |
| WORK-002 | [Make a conditional job offer](hr-lead/make-a-job-offer.md), [Record a pre-employment check](hr-lead/record-a-pre-employment-check.md), [Start a staff file](hr-lead/start-a-staff-file.md) |
| WORK-003 | [Record a sponsored worker](hr-lead/record-a-sponsored-worker.md), [Record absences and report changes for a sponsored worker](hr-lead/report-a-change-for-a-sponsored-worker.md) |
| WORK-004 | [Record Care Certificate progress](hr-lead/record-care-certificate-progress.md), [Record a probation decision](hr-lead/decide-probation.md), [Run a new starter's induction](hr-lead/run-a-new-starters-induction.md) |
| WORK-005 | [Check the training matrix](hr-lead/check-the-training-matrix.md), [Record training](hr-lead/record-training.md), [Set the training each role needs](hr-lead/set-training-requirements.md) |
| WORK-006 | [Add an e-learning course](hr-lead/add-an-e-learning-course.md), [Download a training course to the phone](care-worker/download-a-training-course-to-the-phone.md), [Take a training course offline on the phone](care-worker/take-a-training-course-offline-on-the-phone.md), [Take an e-learning course](care-worker/take-an-e-learning-course.md) |
| WORK-008 | [Sign off a competence you observed](senior-carer/sign-off-a-competence.md), [Withdraw a competence sign-off](senior-carer/withdraw-a-competence-sign-off.md) |
| WORK-009 | [Record a supervision, appraisal or spot check](hr-lead/record-a-supervision.md) |
| WORK-010 | [Decide an employee relations case outcome or appeal](hr-lead/decide-a-case-outcome-or-appeal.md), [Export an employee relations case](hr-lead/export-an-employee-relations-case.md), [Open an employee relations case](hr-lead/open-an-employee-relations-case.md), [Run an employee relations case](hr-lead/run-an-employee-relations-case.md) |
| WORK-012 | [Record a nurse's revalidation evidence](hr-lead/record-revalidation-evidence.md), [Record a pre-employment check](hr-lead/record-a-pre-employment-check.md) |
| WORK-013 | [End a leaver's access now](hr-lead/end-a-leavers-access-now.md), [Record a member of staff leaving](hr-lead/record-a-leaver.md), [Record and answer a reference request](hr-lead/answer-a-reference-request.md) |
| PLAT-012 | [Destroy the organisation's stored files when it leaves Thapsus Care](data-protection-lead/shred-the-organisations-records.md), [Place or release a legal hold](data-protection-lead/place-or-release-a-legal-hold.md), [Destroy documents past their retention period](data-protection-lead/destroy-documents-past-their-retention-period.md) |
| INTG-014 | [Link Thapsus Care to your HR platform](registered-manager/link-to-the-hr-platform.md), [Release absence copies from the HR platform](registered-manager/release-absence-copies.md), [Pay staff through the HR platform](registered-manager/set-the-route-to-payroll.md) |
| SCHED-008 | [Pay staff through the HR platform](registered-manager/set-the-route-to-payroll.md) |
| SAFE-013 | [Close an outbreak](nurse/close-an-outbreak.md), [Declare an outbreak](nurse/declare-an-outbreak.md), [Fill in the outbreak report](nurse/fill-in-the-outbreak-report.md), [Keep an outbreak line list](nurse/keep-an-outbreak-line-list.md) |
| SAFE-016 | [Approve or refuse a disclosure request](registered-manager/approve-or-refuse-a-disclosure-request.md), [Log a disclosure request](nurse/log-a-disclosure-request.md), [Record a coroner's report to prevent future deaths](nurse/record-a-coroners-report-to-prevent-future-deaths.md), [Release and hand over a disclosure pack](nurse/release-and-hand-over-a-disclosure-pack.md), [Review the records for a disclosure request](nurse/review-records-for-a-disclosure-request.md) |

**Phase 1 rows with no guide yet**: INTG-011 (email, text message and push settings have no
screen on `main`), and the phone's Care mode rows (MOB-002, MOB-005, MOB-006, MOB-009, MOB-010):
Care mode has screens on the phone (notes, charts, the body map, the round and the handover), but
their guides are still to write. Consent, capacity and DoLS (CARE-021, CARE-022) are still read
only on the web. Write each guide with its screen.

**Phase 2 rows with no guide yet**, because they have no screen on `main`: INTG-006 (the dm+d
release history), INTG-007 (identity and vetting checks) and INTG-013 (e-signature and scanning
paper MARs). Single sign-on (PLAT-005) has a guide that says what exists without a screen. The
phone's controlled drugs and medicines guides wait for those phone screens to merge.

The scripted Phase 1 demonstration is in [docs/demo/phase-1-walkthrough.md](../demo/phase-1-walkthrough.md).
