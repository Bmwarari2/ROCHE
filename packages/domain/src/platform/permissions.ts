/**
 * Permission catalogue (master prompt section 4). Permissions are named `module.resource.action`,
 * where `module` is one of the 14 bounded contexts. Roles are bundles of these keys plus a scope
 * rule. New modules add their permissions here; `docs/specs/platform.md` renders this table.
 *
 * `stepUp` marks actions that need fresh re-authentication (section 5.3): controlled drugs,
 * residents' money, data export, break-glass and statutory notification submission.
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
  "platform.data.export": { description: "Export the tenant's full dataset", stepUp: true },
  "platform.import.run": { description: "Run the migration import wizard" },
  "platform.billing.read": { description: "See the tenant's Harbour subscription and invoices" },
  "platform.dpia.sign": { description: "Sign the DPIA and data processing agreement" },
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
  "people.sharing.manage": { description: "Manage family and professional sharing rules" },
  "people.demographics.read": { description: "Read names and room only (no care data)" },
  // care
  "care.plan.read": { description: "Read care plans and risk assessments", careRecord: true },
  "care.plan.write": { description: "Write care plans and risk assessments", careRecord: true },
  "care.note.write": { description: "Write daily notes and charts", careRecord: true },
  "care.note.read": { description: "Read daily notes and charts", careRecord: true },
  "care.assessment.write": { description: "Complete validated assessments", careRecord: true },
  "care.handover.manage": { description: "Compile and acknowledge handovers", careRecord: true },
  "care.capacity.write": {
    description: "Record capacity and best-interests decisions",
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
  "safety.incident.manage": { description: "Investigate and close incidents", careRecord: true },
  "safety.notification.submit": {
    description: "Submit statutory notifications (CQC, RIDDOR, safeguarding)",
    stepUp: true,
  },
  "safety.safeguarding.manage": { description: "Manage the safeguarding log", careRecord: true },
  "safety.complaint.manage": { description: "Manage complaints and compliments" },
  "safety.whistleblowing.read": { description: "Read speak-up concerns (anonymised)" },
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
