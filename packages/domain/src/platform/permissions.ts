/**
 * Permission catalogue (master prompt section 4). Permissions are named `module.resource.action`,
 * where `module` is one of the 14 bounded contexts. Roles are bundles of these keys plus a scope
 * rule. New modules add their permissions here; `docs/specs/platform.md` renders this table.
 *
 * `stepUp` marks actions that need fresh re-authentication (section 5.3): controlled drugs,
 * residents' money, data export (`platform.export.create`), break-glass and statutory
 * notification submission.
 */

export const BOUNDED_CONTEXTS = [
  "platform",
  "people",
  "care",
  "medicines",
  "safety",
  "quality",
  "workforce",
  "scheduling",
  "operations",
  "finance",
  "comms",
  "insights",
  "integrations",
  "ai",
] as const;

export type BoundedContext = (typeof BOUNDED_CONTEXTS)[number];

export interface PermissionDefinition {
  readonly description: string;
  readonly stepUp?: boolean;
  /** Reads or writes care records (MFA is mandatory for any role holding one). */
  readonly careRecord?: boolean;
}

export const PERMISSIONS = {
  // platform
  "platform.tenant.manage": { description: "Change tenant settings, branding and terminology" },
  "platform.location.manage": { description: "Create and change locations and services" },
  "platform.user.manage": { description: "Invite users, assign roles and suspend accounts" },
  "platform.role.manage": { description: "Design, clone and version roles" },
  "platform.flag.manage": { description: "Switch modules on or off for the tenant and locations" },
  "platform.audit.read": { description: "Read the audit log and record history" },
  "platform.export.create": {
    // The export holds every care record, so it needs MFA, and its step-up is an MFA sign-in.
    description: "Create and download the organisation's full data export (free, at any time)",
    stepUp: true,
    careRecord: true,
  },
  "platform.import.run": { description: "Run the migration import wizard" },
  "platform.billing.read": { description: "See the tenant's Harbour subscription and invoices" },
  "platform.search.use": {
    description: "Search the people, staff, documents and notes you can already see",
  },
  "platform.search.archived": {
    description: "Include discharged, deceased and archived people and their records in search",
  },
  "platform.onboarding.read": { description: "See the organisation's onboarding checklist" },
  "platform.onboarding.manage": {
    description: "Load and remove sample data and record onboarding decisions",
  },
  "platform.dpia.read": {
    description: "Read the DPIA, the records of processing and the sub-processor register",
  },
  "platform.dpia.prepare": {
    description: "Prepare the DPIA and keep the processing registers up to date",
  },
  "platform.dpia.sign": {
    description:
      "Sign the DPIA and data processing agreement as the named data protection lead, and answer sub-processor notices",
    stepUp: true,
  },
  "platform.grant.manage": { description: "Give time-boxed delegation and acting-up grants" },
  "platform.task.manage": { description: "Create, assign and reassign tasks for other people" },
  "platform.document.manage": { description: "Upload and manage organisation documents" },
  "platform.retention.manage": {
    description:
      "Place and release legal holds and approve destruction of records past retention (tenant-wide roles only)",
    stepUp: true,
  },
  "platform.support.approve": {
    description: "Approve or decline Thapsus support access to the organisation's data",
    stepUp: true,
  },
  "platform.device.read": {
    description: "See which Care mode devices staff have used, and whether a device is revoked",
  },
  "platform.device.revoke": {
    // A revoked device wipes at its next contact, keeping only unsent entries under the hold rules
    // (care.md section 6, Device integrity part 2).
    description: "Revoke a lost or withdrawn Care mode device, so it wipes at its next contact",
    stepUp: true,
  },
  // people
  "people.person.read": { description: "Read person records in scope", careRecord: true },
  "people.person.create": { description: "Create person records", careRecord: true },
  "people.person.update": { description: "Change demographics and contacts", careRecord: true },
  "people.person.break_glass": {
    description: "Open a record outside scope with a justification",
    stepUp: true,
    careRecord: true,
  },
  "people.enquiry.manage": { description: "Manage enquiries and referrals" },
  "people.admission.manage": {
    description: "Admit, transfer and discharge people",
    careRecord: true,
  },
  "people.movement.record": {
    description:
      "Record a person going to hospital or on leave, their return, or their death, and print the transfer pack",
    careRecord: true,
  },
  "people.property.manage": {
    description: "Record personal property, valuables and keys, and their return",
    careRecord: true,
  },
  "people.assignment.manage": { description: "Assign staff to people" },
  "people.sharing.manage": {
    description: "Manage family and professional sharing rules and About Me share links",
    careRecord: true,
  },
  "people.demographics.read": { description: "Read names and room only (no care data)" },
  // care
  "care.plan.read": { description: "Read care plans and risk assessments", careRecord: true },
  "care.plan.write": { description: "Write care plans and risk assessments", careRecord: true },
  "care.note.write": { description: "Write daily notes and charts", careRecord: true },
  "care.note.read": { description: "Read daily notes and charts", careRecord: true },
  "care.assessment.write": { description: "Complete validated assessments", careRecord: true },
  "care.handover.manage": {
    description: "Read, compile, annotate and acknowledge shift handovers",
    careRecord: true,
  },
  "care.held_entry.hand_over": {
    // care.md section 6, Device integrity part 6: entries are written as their owner's, and the
    // manager is recorded (HZ-040).
    description:
      "Send another member of staff's unsent entries held on a device to Harbour, on their behalf",
    stepUp: true,
    careRecord: true,
  },
  "care.capacity.write": {
    description: "Record consent, capacity assessments and best-interests decisions",
    careRecord: true,
  },
  "care.dols.manage": { description: "Manage the DoLS register", careRecord: true },
  "care.respect.record": { description: "Record ReSPECT and DNACPR documents", careRecord: true },
  "care.delegated.signoff": {
    description: "Sign off delegated healthcare plans",
    careRecord: true,
  },
  // medicines
  "medicines.record.manage": {
    description: "Manage medicines records and reconciliation",
    careRecord: true,
  },
  "medicines.emar.administer": { description: "Record administrations", careRecord: true },
  "medicines.cd.administer": {
    description: "Record controlled-drug administrations",
    stepUp: true,
    careRecord: true,
  },
  "medicines.cd.witness": { description: "Witness controlled-drug entries", careRecord: true },
  "medicines.stock.manage": {
    description: "Manage stock, ordering and disposal",
    careRecord: true,
  },
  "medicines.override.approve": {
    description: "Approve overrides such as expired competence",
    careRecord: true,
  },
  // safety
  "safety.incident.report": { description: "Report incidents and near misses" },
  "safety.incident.read": {
    description: "Read incidents in scope, with the people on them that are in scope",
    careRecord: true,
  },
  "safety.incident.manage": { description: "Investigate and close incidents", careRecord: true },
  "safety.notification.submit": {
    description:
      "Submit statutory notifications (CQC, RIDDOR, safeguarding) or mark them not required",
    stepUp: true,
    careRecord: true,
  },
  "safety.safeguarding.manage": { description: "Manage the safeguarding log", careRecord: true },
  "safety.complaint.manage": { description: "Manage complaints and compliments" },
  "safety.whistleblowing.read": { description: "Read speak-up concerns (anonymised)" },
  "safety.speak_up.manage": {
    description:
      "Freedom to Speak Up lead: receive, manage and reply to speak-up concerns (a silo permission, ADR-0089)",
    careRecord: true,
  },
  "safety.disclosure.approve": { description: "Approve coroner, police and solicitor disclosures" },
  // quality
  "quality.audit.manage": { description: "Run audits and mock inspections" },
  "quality.policy.manage": { description: "Publish policies and read-and-sign campaigns" },
  "quality.evidence.manage": {
    description: "Manage the evidence library (tag records against quality statements)",
  },
  "quality.dsar.manage": { description: "Run the DSAR workbench and breach register" },
  "quality.evidence.read": {
    description: "Open evidence packs released to you (inspectors only)",
    careRecord: true,
  },
  "quality.evidence_pack.compose": {
    description:
      "Compose inspector evidence packs (evidence, people in scope, redactions) and revoke their links",
    careRecord: true,
  },
  "quality.evidence_pack.release": {
    description:
      "Release an evidence pack to its recipient by a time-limited link (not the person who composed it)",
    stepUp: true,
    careRecord: true,
  },
  "quality.statement_of_purpose.write": {
    description: "Draft changes to the statement of purpose",
  },
  "quality.statement_of_purpose.approve": {
    description:
      "Approve a statement of purpose revision (the registered provider or manager; not its author)",
  },
  // workforce
  "workforce.recruitment.manage": { description: "Manage applicants and pre-employment files" },
  "workforce.training.manage": { description: "Manage the training matrix and competence" },
  "workforce.competence.observe": { description: "Observe and sign off competence" },
  "workforce.supervision.manage": { description: "Schedule and record supervisions" },
  "workforce.casework.manage": { description: "Manage employee relations casework" },
  "workforce.self.read": { description: "Read own training, documents and pay" },
  // scheduling
  "scheduling.rota.read": { description: "Read rotas" },
  "scheduling.rota.manage": { description: "Build and publish rotas" },
  "scheduling.rota.approve": { description: "Approve rotas and timesheets" },
  "scheduling.visit.manage": { description: "Schedule visits and monitor ECM" },
  "scheduling.timesheet.self": { description: "Clock in and out and view own timesheets" },
  // operations
  "operations.premises.manage": { description: "Manage assets and the statutory checks calendar" },
  "operations.catering.manage": {
    description: "Manage menus, allergen matrix and food safety logs",
  },
  "operations.housekeeping.manage": { description: "Manage cleaning and laundry records" },
  "operations.activities.manage": { description: "Manage the activities programme" },
  "operations.visitors.manage": { description: "Manage visitors and appointments" },
  "operations.occupancy.manage": { description: "Manage the bed board and enquiries" },
  "operations.downtime.read": {
    description: "Print or open the location's downtime pack",
    careRecord: true,
  },
  "operations.downtime.manage": {
    description:
      "Declare and close outages and confirm that paper records from an outage were entered",
    careRecord: true,
  },
  // finance
  "finance.billing.manage": { description: "Manage funding, charges and invoices" },
  "finance.ledger.record": { description: "Record residents' money transactions" },
  "finance.ledger.approve": {
    description: "Approve residents' money transactions",
    stepUp: true,
  },
  "finance.reporting.read": { description: "Read location P&L and fee analytics" },
  "finance.payroll.export": { description: "Export approved timesheets to payroll" },
  // comms
  "comms.message.send": { description: "Send internal messages and announcements" },
  "comms.portal.family": { description: "Use the family portal for one person" },
  "comms.portal.self": { description: "Use the person's own portal" },
  "comms.letter.manage": {
    description: "Write letters and emails from approved templates and send them",
  },
  "comms.template.write": { description: "Write and change letter and email templates" },
  "comms.template.approve": {
    description: "Approve letter and email templates for use (not the template's author)",
  },
  "comms.feed.read": {
    description: "Read the family feed and the care plan sections a sharing decision opens",
    careRecord: true,
  },
  "comms.feed.publish": {
    description: "Mark notes as shareable, choose photos and publish family updates",
    careRecord: true,
  },
  "comms.feed.withdraw": {
    description: "Take a family update down with a reason",
    careRecord: true,
  },
  "comms.notification.subscribe": {
    description: "Choose own channels and quiet hours for family update notifications",
  },
  "comms.notification.manage": {
    description: "See family notification delivery problems and the location's settings",
  },
  "comms.visit_booking.request": { description: "Ask to book a visit through the family portal" },
  "comms.visit_booking.manage": {
    description: "See and cancel visit bookings and set online booking hours",
  },
  // insights
  "insights.dashboard.read": { description: "Read role dashboards" },
  "insights.report.manage": { description: "Build and schedule reports" },
  "insights.group.read": { description: "Read consolidated reporting across a group" },
  // integrations
  "integrations.connection.manage": { description: "Configure integrations and API clients" },
  // ai
  "ai.copilot.use": { description: "Use the AI management copilot (advisory only)" },
  "ai.copilot.manage": { description: "Configure the AI module and provider" },
} as const satisfies Record<string, PermissionDefinition>;

/**
 * Silo permissions (ADR-0089): held only through a role that carries nothing else, never by a role
 * built from "every permission", never through an access grant, and never together with a role
 * that manages users or roles. Row-level security repeats it (migration 0086).
 */
export const SILO_PERMISSIONS = ["safety.speak_up.manage"] as const;

export function isSiloPermission(permission: string): boolean {
  return (SILO_PERMISSIONS as readonly string[]).includes(permission);
}

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

export function permissionContext(permission: Permission): BoundedContext {
  return permission.split(".")[0] as BoundedContext;
}

export function requiresStepUp(permission: Permission): boolean {
  const definition: PermissionDefinition = PERMISSIONS[permission];
  return definition.stepUp === true;
}

export function touchesCareRecords(permission: Permission): boolean {
  const definition: PermissionDefinition = PERMISSIONS[permission];
  return definition.careRecord === true;
}
