# User guides

Short, task-based guides for the people who use Harbour, one task per guide. They describe what
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

Phase 1 rows (and the Phase 0 rows with Phase 1 screens), and the Phase 2 safety, quality and platform rows (slice 83), that have a guide. Rows marked "screens with the next merge" describe screens on the `feat/quality-dashboard-pir` branch. The register's user
docs column links the same guides.

| Row | Guides |
| --- | --- |
| PLAT-004 | [Sign in](all-staff/sign-in.md), [Accept an invitation](all-staff/accept-an-invitation.md), [Set up a passkey or authenticator app](all-staff/set-up-a-second-sign-in-step.md), [Invite a team member](registered-manager/invite-a-team-member.md) |
| PLAT-005 | [Turn on single sign-on](owner/turn-on-single-sign-on.md) (no screen yet) |
| PLAT-006 | [Open a record with break-glass](registered-manager/open-a-record-with-break-glass.md), [Review the weekly break-glass report](registered-manager/review-the-weekly-break-glass-report.md) |
| PLAT-007 | [See the history of a record](all-staff/view-a-records-history.md) |
| PLAT-013 | [Search for a person](all-staff/search-for-a-person.md), [Open a record with break-glass](registered-manager/open-a-record-with-break-glass.md) |
| PLAT-014 | [Import people from another system](owner/import-people-from-another-system.md), [Undo an import](owner/undo-an-import.md) |
| PLAT-015 | [Get a full export](owner/request-a-full-export.md) |
| PLAT-018 | [Work through getting started](owner/work-through-getting-started.md) |
| PLAT-022 | [Handle a data rights request](data-protection-lead/handle-a-data-rights-request.md), [Find and review the records for a data rights request](data-protection-lead/find-and-review-the-records-for-a-request.md), [Send the response to a data rights request](data-protection-lead/send-the-response-to-a-data-rights-request.md), [Handle a request to erase, correct or move information](data-protection-lead/handle-an-erasure-correction-or-portability-request.md), [Record and handle a data breach](data-protection-lead/record-a-data-breach.md), [Acknowledge a breach notice from Thapsus](data-protection-lead/acknowledge-a-breach-notice-from-thapsus.md), [Handle a data protection complaint](data-protection-lead/handle-a-data-protection-complaint.md) |
| PLAT-023 | [Prepare and sign the DPIA](data-protection-lead/prepare-and-sign-the-dpia.md) |
| PEOP-001 | [Check the person's details](care-worker/check-the-person-before-you-act.md) |
| PEOP-002 | [Check the person's details](care-worker/check-the-person-before-you-act.md) |
| PEOP-008 | [Record a review](nurse/record-a-review.md) |
| PEOP-009 | [Send someone to hospital](senior-carer/send-someone-to-hospital.md) |
| PEOP-010 | [Record a death](senior-carer/record-a-death.md) |
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
| SAFE-001 | [Record an incident](care-worker/record-an-incident.md), [Review and close an incident](registered-manager/review-and-close-an-incident.md) |
| SAFE-002 | [Answer the notification questions](registered-manager/answer-notification-questions.md), [Read the notification clocks](registered-manager/read-notification-clocks.md), [Record a notification as submitted](registered-manager/record-a-notification-as-submitted.md) |
| SAFE-003 | [Prepare a statutory notification](registered-manager/prepare-a-statutory-notification.md), [Record a notification as submitted](registered-manager/record-a-notification-as-submitted.md) |
| SAFE-004 | [Prepare a statutory notification](registered-manager/prepare-a-statutory-notification.md), [Read the notification clocks](registered-manager/read-notification-clocks.md) |
| SAFE-005 | [Prepare a statutory notification](registered-manager/prepare-a-statutory-notification.md), [Read the notification clocks](registered-manager/read-notification-clocks.md) |
| SAFE-006 | [Raise a safeguarding concern](care-worker/raise-a-safeguarding-concern.md), [Check a person's safeguarding measures](care-worker/check-safeguarding-measures.md), [Run the safeguarding log](registered-manager/run-the-safeguarding-log.md) |
| SAFE-008 | [Follow up after a death](registered-manager/follow-up-after-a-death.md) |
| SAFE-009 | [Record an incident (after a fall)](care-worker/record-an-incident.md), [Mark the body map](care-worker/mark-the-body-map.md) |
| SAFE-011 | [Handle a complaint](registered-manager/handle-a-complaint.md), [Record a compliment](registered-manager/record-a-compliment.md) |
| SAFE-012 | [Raise a speak-up concern](all-staff/raise-a-speak-up-concern.md), [Speak up anonymously](all-staff/speak-up-anonymously.md), [Handle speak-up cases](all-staff/handle-speak-up-cases.md) |
| SAFE-014 | [Record a death](senior-carer/record-a-death.md), [Follow up after a death](registered-manager/follow-up-after-a-death.md) |
| SAFE-015 | [Record a missing person](care-worker/record-a-missing-person.md) |
| QUAL-001 | [Read the compliance framework and map its statements](registered-manager/map-the-compliance-framework.md) |
| QUAL-002 | [Read the compliance framework and map its statements](registered-manager/map-the-compliance-framework.md), [Tag a record as evidence](registered-manager/tag-a-record-as-evidence.md), [Check evidence coverage and its gaps](registered-manager/check-evidence-coverage.md) |
| QUAL-004 | [Add, schedule and retire an audit template](registered-manager/set-up-an-audit-template.md), [Carry out an audit or mock inspection](registered-manager/carry-out-an-audit.md) |
| QUAL-005 | [Read the quality dashboard](registered-manager/read-the-quality-dashboard.md), [Set indicator targets](registered-manager/set-indicator-targets.md) (screens with the next merge) |
| QUAL-006 | [Copy the PIR figures](registered-manager/copy-the-pir-figures.md) (screens with the next merge) |
| QUAL-008 | [Read and sign a policy](all-staff/read-and-sign-a-policy.md), [Write and publish a policy](registered-manager/write-and-publish-a-policy.md), [Check who has read and signed a policy](registered-manager/check-who-has-signed-a-policy.md), [Retire a policy](registered-manager/retire-a-policy.md) (screens with the next merge) |
| QUAL-012 | [Track DSPT assertions and their evidence](data-protection-lead/track-dspt-assertions-and-evidence.md), [Record a DSPT submission](data-protection-lead/record-a-dspt-submission.md), [Record a Cyber Essentials certificate or ICO registration](data-protection-lead/record-a-certificate-or-registration.md) (screens with the next merge) |
| WORK-011 | [Handle a data rights request](data-protection-lead/handle-a-data-rights-request.md), [Find and review the records for a data rights request](data-protection-lead/find-and-review-the-records-for-a-request.md) |
| OPS-028 | [Print the downtime pack](senior-carer/print-the-downtime-pack.md), [Declare and close an outage](senior-carer/declare-and-close-an-outage.md), [Enter paper records](care-worker/enter-paper-records-after-an-outage.md), [Reconcile an outage](registered-manager/reconcile-an-outage.md) |
| COMMS-001 | [Publish a family update](senior-carer/publish-a-family-update.md), [Read updates from the home](family-member/read-updates.md) |
| COMMS-006 | [Read and acknowledge the handover](care-worker/read-and-acknowledge-the-handover.md) |
| COMMS-007 | [Write a letter template](registered-manager/write-a-letter-template.md), [Make a letter](registered-manager/make-a-letter.md) |

**Phase 1 rows with no guide yet**, because they have no web screen on `main` (or are paused with
mobile): PLAT-002, PLAT-009, PLAT-011, PLAT-012, PEOP-003, PEOP-005, PEOP-007, PEOP-013,
SAFE-007, SAFE-010, QUAL-003 (see the [inspector page](inspector/open-an-evidence-pack.md)),
QUAL-009, INSI-001, INTG-011 and the MOB rows. Write each guide with its screen.

**Phase 2 safety, quality and platform rows with no guide yet** (slice 83), because their screens
are still to come: SAFE-013 (outbreaks and IPC; screens in slice 63) and SAFE-016 (coroner, police
and solicitor disclosures; H-829). The death record, its steps and the mortality review, the
missing person episode and the Herbert Protocol profile have no screens yet either: their guides
say what does exist today.

The scripted Phase 1 demonstration is in [docs/demo/phase-1-walkthrough.md](../demo/phase-1-walkthrough.md).
