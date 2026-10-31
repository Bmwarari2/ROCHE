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

Phase 1 rows (and the Phase 0 rows with Phase 1 screens) that have a guide. The register's user
docs column links the same guides.

| Row | Guides |
| --- | --- |
| PLAT-004 | [Sign in](all-staff/sign-in.md), [Accept an invitation](all-staff/accept-an-invitation.md), [Set up a passkey or authenticator app](all-staff/set-up-a-second-sign-in-step.md), [Invite a team member](registered-manager/invite-a-team-member.md) |
| PLAT-006 | [Open a record with break-glass](registered-manager/open-a-record-with-break-glass.md), [Review the weekly break-glass report](registered-manager/review-the-weekly-break-glass-report.md) |
| PLAT-007 | [See the history of a record](all-staff/view-a-records-history.md) |
| PLAT-013 | [Search for a person](all-staff/search-for-a-person.md), [Open a record with break-glass](registered-manager/open-a-record-with-break-glass.md) |
| PLAT-015 | [Get a full export](owner/request-a-full-export.md) |
| PLAT-018 | [Work through getting started](owner/work-through-getting-started.md) |
| PLAT-022 | [Handle a data rights request](data-protection-lead/handle-a-data-rights-request.md) |
| PLAT-023 | [Prepare and sign the DPIA](data-protection-lead/prepare-and-sign-the-dpia.md) |
| PEOP-001 | [Check the person's details](care-worker/check-the-person-before-you-act.md) |
| PEOP-002 | [Check the person's details](care-worker/check-the-person-before-you-act.md) |
| PEOP-008 | [Record a review](nurse/record-a-review.md) |
| PEOP-009 | [Send someone to hospital](senior-carer/send-someone-to-hospital.md) |
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
| SAFE-009 | [Record an incident (after a fall)](care-worker/record-an-incident.md), [Mark the body map](care-worker/mark-the-body-map.md) |
| OPS-028 | [Print the downtime pack](senior-carer/print-the-downtime-pack.md), [Declare and close an outage](senior-carer/declare-and-close-an-outage.md), [Enter paper records](care-worker/enter-paper-records-after-an-outage.md), [Reconcile an outage](registered-manager/reconcile-an-outage.md) |
| COMMS-001 | [Publish a family update](senior-carer/publish-a-family-update.md), [Read updates from the home](family-member/read-updates.md) |
| COMMS-006 | [Read and acknowledge the handover](care-worker/read-and-acknowledge-the-handover.md) |
| COMMS-007 | [Write a letter template](registered-manager/write-a-letter-template.md), [Make a letter](registered-manager/make-a-letter.md) |

**Phase 1 rows with no guide yet**, because they have no web screen on `main` (or are paused with
mobile): PLAT-002, PLAT-009, PLAT-011, PLAT-012, PEOP-003, PEOP-005, PEOP-007, PEOP-010, PEOP-013,
SAFE-007, SAFE-008, SAFE-010, QUAL-003 (see the [inspector page](inspector/open-an-evidence-pack.md)),
QUAL-009, INSI-001, INTG-011 and the MOB rows. Write each guide with its screen.

The scripted Phase 1 demonstration is in [docs/demo/phase-1-walkthrough.md](../demo/phase-1-walkthrough.md).
