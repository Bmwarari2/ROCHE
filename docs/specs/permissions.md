# Permission matrix

Generated from `packages/domain/src/platform/permissions.ts` and `roles.ts` by
`pnpm --filter @harbour/domain permissions:doc`. Do not edit by hand. Master prompt section 4.

Permissions are named `module.resource.action`. **Step-up** permissions need a sign-in within the
last 10 minutes (section 5.3). **Care record** permissions need MFA (TOTP or a passkey). Roles are
per-tenant copies of these built-in roles; tenants may rename or clone them.

## Built-in roles and scope

| Key | Name | Scope | Expiry required | Description |
| --- | --- | --- | --- | --- |
| `owner` | Owner | tenant |  | Founder, director or Nominated Individual. Everything, including billing. |
| `group_executive` | Group executive | tenant |  | Cross-location dashboards, finance, workforce and audits; no clinical edits. |
| `registered_manager` | Registered Manager | location |  | Full operational control of a location, including CQC notifications. |
| `deputy_manager` | Deputy manager | location |  | As Registered Manager minus tenant settings; submits notifications only under an acting-up grant. |
| `clinical_lead` | Clinical lead or nurse | location |  | Clinical assessments, controlled drugs, delegated-healthcare sign-off, ReSPECT. |
| `team_leader` | Team leader or senior carer | location |  | Handover, task allocation, eMAR, incidents, spot checks, competency observation. |
| `care_worker` | Care or support worker | assigned |  | Daily notes, charts, eMAR within competence, incidents, own rota and timesheets. |
| `care_coordinator` | Care coordinator | location |  | Scheduling, visit monitoring, package changes and on-call escalation. |
| `activities` | Activities | none |  | Activity records only; no care notes. |
| `catering` | Catering | none |  | Menus, allergen flags and food safety logs; no care notes. |
| `housekeeping` | Housekeeping | none |  | Cleaning and laundry logs; no care notes. |
| `maintenance` | Maintenance | none |  | Assets, statutory checks and maintenance logs; no care notes. |
| `administrator` | Administrator or receptionist | location |  | Enquiries, visitors, documents and appointments; read-only demographics. |
| `finance` | Finance | none |  | Fees, invoicing, residents' money oversight, payroll export, budgets; no care notes. |
| `hr` | HR, recruitment or training lead | none |  | Recruitment, compliance files, training matrix, supervision; no care notes. |
| `employee_relations_lead` | Employee relations caseworker | none |  | Opens grievance, disciplinary, capability, sickness and probation cases; reads only cases they are named on. |
| `quality_lead` | Quality and compliance lead | tenant |  | Audits, policies, evidence, DSAR and breach registers, whistleblowing (anonymised). |
| `external_professional` | External professional | assigned | yes | GP, district nurse, pharmacist, social worker: named people, time-limited. |
| `family_representative` | Family or representative | assigned |  | Portal for one person: updates, consented care plan sections, invoices, messages. |
| `person_receiving_care` | Person receiving care | self |  | Own portal: About Me, notes feed, preferences, feedback. |
| `agency_worker` | Agency or bank worker | assigned | yes | As care worker, auto-expiring at shift end plus 2 hours. |
| `inspector` | Inspector or auditor | none | yes | Read-only, time-boxed, watermarked evidence packs. |
| `speak_up_guardian` | Freedom to Speak Up lead | tenant |  | Receives and manages speak-up concerns, named, confidential or anonymous. |

Scope decides whom a role may act on, enforced again by Postgres row-level security (ADR-0002):
`tenant` everyone, `location` people at the assigned locations, `assigned` and `self` assigned
people only (plus break-glass), `none` no person records.

Scope is per permission (ADR-0071): a permission reaches only the people the roles that carry it
reach, plus where a grant carrying it is given (its location, or the whole organisation without
one), never the scope of another role the user also holds. A request runs under the scope of the
permission it requires, or the narrowest of several; a request that requires none sees no one. A
care worker at one home who is also a finance viewer across the organisation writes care notes at
that home only.

## Permissions by role

| Permission | Step-up | Care record | owner | group_executive | registered_manager | deputy_manager | clinical_lead | team_leader | care_worker | care_coordinator | activities | catering | housekeeping | maintenance | administrator | finance | hr | employee_relations_lead | quality_lead | external_professional | family_representative | person_receiving_care | agency_worker | inspector | speak_up_guardian |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `platform.tenant.manage` |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.location.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.user.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.role.manage` |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.flag.manage` |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.audit.read` |  |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `platform.export.create` | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.import.run` |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.billing.read` |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.search.use` |  |  | yes | yes | yes | yes | yes | yes | yes | yes |  |  |  |  | yes |  | yes |  | yes |  |  |  | yes |  |  |
| `platform.search.archived` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `platform.onboarding.read` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `platform.onboarding.manage` |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.dpia.read` |  |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `platform.dpia.prepare` |  |  | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `platform.dpia.sign` | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `platform.grant.manage` |  |  | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.task.manage` |  |  | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.document.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  | yes |  |  |  |  |  |  |
| `platform.retention.manage` | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `platform.support.approve` | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.device.read` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.device.revoke` | yes |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.person.read` |  | yes | yes | yes | yes | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  | yes | yes |  |  | yes |  |  |
| `people.person.create` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.person.update` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.person.break_glass` | yes | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.enquiry.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |
| `people.admission.manage` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.movement.record` |  | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.property.manage` |  | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.assignment.manage` |  |  | yes |  | yes | yes |  | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.sharing.manage` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `people.demographics.read` |  |  | yes |  | yes | yes |  |  |  |  | yes | yes |  |  | yes | yes |  |  |  |  |  |  |  |  |  |
| `care.plan.read` |  | yes | yes | yes | yes | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  | yes | yes |  |  | yes |  |  |
| `care.plan.write` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `care.note.write` |  | yes | yes |  | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  | yes |  |  | yes |  |  |
| `care.note.read` |  | yes | yes | yes | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  | yes | yes |  |  | yes |  |  |
| `care.assessment.write` |  | yes | yes |  | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |
| `care.dependency.assess` |  | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `care.handover.manage` |  | yes | yes |  | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |
| `care.held_entry.hand_over` | yes | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `care.capacity.write` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `care.dols.manage` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `care.respect.record` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `care.delegated.signoff` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `medicines.record.manage` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `medicines.emar.administer` |  | yes | yes |  | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |
| `medicines.cd.administer` | yes | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `medicines.cd.witness` |  | yes | yes |  | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `medicines.stock.manage` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `medicines.override.approve` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `safety.incident.report` |  |  | yes |  | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |  |  |  |  |  |  |  | yes |  |  |
| `safety.incident.read` |  | yes | yes |  | yes | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  | yes |  |  |
| `safety.incident.manage` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `safety.notification.submit` | yes | yes | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `safety.safeguarding.manage` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `safety.outbreak.manage` |  | yes | yes |  | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `safety.complaint.manage` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `safety.whistleblowing.read` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `safety.speak_up.manage` |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |
| `safety.disclosure.approve` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `quality.audit.manage` |  |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `quality.policy.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `quality.evidence.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `quality.dsar.manage` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `quality.evidence.read` |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |
| `quality.evidence_pack.compose` |  | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `quality.evidence_pack.release` | yes | yes | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `quality.statement_of_purpose.write` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `quality.statement_of_purpose.approve` |  |  | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `workforce.recruitment.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |
| `workforce.training.manage` |  |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |
| `workforce.competence.observe` |  |  | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |
| `workforce.supervision.manage` |  |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |
| `workforce.casework.manage` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |
| `workforce.self.read` |  |  | yes |  | yes | yes | yes | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |
| `workforce.staff_file.read` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |
| `workforce.staff_file.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |
| `workforce.hr_document.read` |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |
| `workforce.dbs_risk_assessment.sign` |  |  | yes |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `scheduling.rota.read` |  |  | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |
| `scheduling.rota.manage` |  |  | yes |  | yes | yes |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `scheduling.rota.approve` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `scheduling.visit.manage` |  |  | yes |  | yes | yes |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `scheduling.timesheet.self` |  |  | yes |  | yes | yes | yes | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |
| `scheduling.dependency.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `operations.premises.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |
| `operations.catering.manage` |  |  | yes |  | yes | yes |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `operations.housekeeping.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |
| `operations.activities.manage` |  |  | yes |  | yes | yes |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `operations.visitors.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |
| `operations.occupancy.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |
| `operations.downtime.read` |  | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `operations.downtime.manage` |  | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.billing.manage` |  |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |
| `finance.ledger.record` |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |
| `finance.ledger.approve` | yes |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |
| `finance.reporting.read` |  |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |
| `finance.payroll.export` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |
| `comms.message.send` |  |  | yes | yes | yes | yes | yes | yes | yes | yes |  |  |  |  | yes |  |  |  |  |  |  |  | yes |  |  |
| `comms.portal.family` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |
| `comms.portal.self` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |
| `comms.letter.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |
| `comms.template.write` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  | yes |  |  |  |  |  |  |
| `comms.template.approve` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `comms.feed.read` |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |
| `comms.feed.publish` |  | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `comms.feed.withdraw` |  | yes | yes |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `comms.notification.subscribe` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |
| `comms.notification.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |
| `comms.visit_booking.request` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |
| `comms.visit_booking.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |  |  |  |  |
| `insights.dashboard.read` |  |  | yes | yes | yes | yes | yes | yes | yes | yes |  |  |  |  |  | yes | yes |  | yes |  |  |  | yes |  |  |
| `insights.report.manage` |  |  | yes | yes | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  | yes |  |  |  |  |  |  |
| `insights.group.read` |  |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `integrations.connection.manage` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `ai.copilot.use` |  |  | yes |  | yes | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `ai.copilot.manage` |  |  | yes |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
