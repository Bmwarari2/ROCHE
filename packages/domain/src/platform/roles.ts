import { ALL_PERMISSIONS, type Permission } from "./permissions";

/**
 * Built-in roles (master prompt section 4). Tenants may rename or clone them; clones are stored
 * per tenant and versioned. The Thapsus operator is not a tenant role: it lives in the operator
 * console with its own database role and approval-ticket impersonation.
 */

export type ScopeKind = "tenant" | "location" | "assigned" | "self" | "none";

export interface BuiltinRole {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly scopeKind: ScopeKind;
  readonly permissions: readonly Permission[];
  /** Agency and visiting roles must carry an expiry on every assignment. */
  readonly requiresExpiry?: boolean;
}

const readCare: Permission[] = ["people.person.read", "care.plan.read", "care.note.read"];
const pointOfCare: Permission[] = [
  ...readCare,
  "care.note.write",
  "care.assessment.write",
  "care.handover.manage",
  "medicines.emar.administer",
  "safety.incident.report",
  "safety.incident.read",
  "scheduling.rota.read",
  "scheduling.timesheet.self",
  "workforce.self.read",
  "comms.message.send",
  "insights.dashboard.read",
  "platform.search.use",
];

/**
 * Permissions only the portal roles hold: a family member's or the person's own access, never a
 * member of staff's (comms.md section 3).
 */
export const PORTAL_ONLY_PERMISSIONS: readonly Permission[] = [
  "comms.portal.family",
  "comms.portal.self",
  "comms.feed.read",
  "comms.notification.subscribe",
  "comms.visit_booking.request",
];

const staffPermission = (p: Permission) => !PORTAL_ONLY_PERMISSIONS.includes(p);

const registeredManager: Permission[] = ALL_PERMISSIONS.filter(
  (p) =>
    !p.startsWith("platform.") &&
    !p.startsWith("ai.copilot.manage") &&
    p !== "insights.group.read" &&
    staffPermission(p) &&
    p !== "finance.ledger.record" &&
    p !== "quality.evidence.read",
).concat([
  "platform.user.manage",
  "platform.audit.read",
  "platform.location.manage",
  "platform.grant.manage",
  "platform.task.manage",
  "platform.document.manage",
  "platform.search.use",
  "platform.search.archived",
  "platform.onboarding.read",
  "platform.dpia.read",
  "platform.dpia.prepare",
  "platform.device.read",
  "platform.device.revoke",
]);

export const BUILTIN_ROLES: readonly BuiltinRole[] = [
  {
    key: "owner",
    name: "Owner",
    description: "Founder, director or Nominated Individual. Everything, including billing.",
    scopeKind: "tenant",
    // Least privilege: opening a released evidence pack by its link is for the inspector it was
    // sent to; providers see their packs through `quality.evidence_pack.compose`.
    permissions: ALL_PERMISSIONS.filter((p) => staffPermission(p) && p !== "quality.evidence.read"),
  },
  {
    key: "group_executive",
    name: "Group executive",
    description: "Cross-location dashboards, finance, workforce and audits; no clinical edits.",
    scopeKind: "tenant",
    permissions: [
      "people.person.read",
      "care.plan.read",
      "care.note.read",
      "finance.reporting.read",
      "finance.billing.manage",
      "workforce.training.manage",
      "workforce.supervision.manage",
      "quality.audit.manage",
      "insights.dashboard.read",
      "insights.report.manage",
      "insights.group.read",
      "platform.audit.read",
      "platform.dpia.read",
      "platform.search.use",
      "scheduling.rota.read",
      "comms.message.send",
    ],
  },
  {
    key: "registered_manager",
    name: "Registered Manager",
    description: "Full operational control of a location, including CQC notifications.",
    scopeKind: "location",
    permissions: registeredManager,
  },
  {
    key: "deputy_manager",
    name: "Deputy manager",
    description:
      "As Registered Manager minus tenant settings; submits notifications only under an acting-up grant.",
    scopeKind: "location",
    // The statement of purpose is approved by the registered provider or manager (CQC
    // Registration Regulations 2009 reg 12), not by a deputy.
    permissions: registeredManager.filter(
      (p) =>
        p !== "safety.notification.submit" &&
        p !== "platform.grant.manage" &&
        p !== "platform.dpia.prepare" &&
        p !== "quality.statement_of_purpose.approve",
    ),
  },
  {
    key: "clinical_lead",
    name: "Clinical lead or nurse",
    description: "Clinical assessments, controlled drugs, delegated-healthcare sign-off, ReSPECT.",
    scopeKind: "location",
    permissions: [
      ...pointOfCare,
      "care.plan.write",
      "care.dependency.assess",
      "care.capacity.write",
      "care.dols.manage",
      "care.respect.record",
      "care.delegated.signoff",
      "medicines.record.manage",
      "medicines.cd.administer",
      "medicines.cd.witness",
      "medicines.stock.manage",
      "safety.incident.manage",
      // Who deletes held entries may also send them (care.md section 6, Device integrity part 6).
      "care.held_entry.hand_over",
      "workforce.competence.observe",
      "platform.task.manage",
      "people.movement.record",
      "people.property.manage",
      "comms.feed.publish",
      "comms.feed.withdraw",
      "operations.downtime.read",
      "operations.downtime.manage",
    ],
  },
  {
    key: "team_leader",
    name: "Team leader or senior carer",
    description: "Handover, task allocation, eMAR, incidents, spot checks, competency observation.",
    scopeKind: "location",
    permissions: [
      ...pointOfCare,
      "care.dependency.assess",
      "medicines.cd.witness",
      "medicines.cd.administer",
      "workforce.competence.observe",
      "people.assignment.manage",
      "platform.task.manage",
      "people.movement.record",
      "people.property.manage",
      "comms.feed.publish",
      "comms.feed.withdraw",
      "operations.downtime.read",
      "operations.downtime.manage",
    ],
  },
  {
    key: "care_worker",
    name: "Care or support worker",
    description: "Daily notes, charts, eMAR within competence, incidents, own rota and timesheets.",
    scopeKind: "assigned",
    permissions: [...pointOfCare, "medicines.cd.witness"],
  },
  {
    key: "care_coordinator",
    name: "Care coordinator",
    description: "Scheduling, visit monitoring, package changes and on-call escalation.",
    scopeKind: "location",
    permissions: [
      "people.person.read",
      "care.plan.read",
      "scheduling.rota.read",
      "scheduling.rota.manage",
      "scheduling.visit.manage",
      "people.assignment.manage",
      "safety.incident.report",
      "safety.incident.read",
      "comms.message.send",
      "insights.dashboard.read",
      "platform.search.use",
    ],
  },
  {
    key: "activities",
    name: "Activities",
    description: "Activity records only; no care notes.",
    scopeKind: "none",
    permissions: [
      "operations.activities.manage",
      "people.demographics.read",
      "safety.incident.report",
      "scheduling.rota.read",
      "scheduling.timesheet.self",
      "workforce.self.read",
    ],
  },
  {
    key: "catering",
    name: "Catering",
    description: "Menus, allergen flags and food safety logs; no care notes.",
    scopeKind: "none",
    permissions: [
      "operations.catering.manage",
      "people.demographics.read",
      "safety.incident.report",
      "scheduling.rota.read",
      "scheduling.timesheet.self",
      "workforce.self.read",
    ],
  },
  {
    key: "housekeeping",
    name: "Housekeeping",
    description: "Cleaning and laundry logs; no care notes.",
    scopeKind: "none",
    permissions: [
      "operations.housekeeping.manage",
      "safety.incident.report",
      "scheduling.rota.read",
      "scheduling.timesheet.self",
      "workforce.self.read",
    ],
  },
  {
    key: "maintenance",
    name: "Maintenance",
    description: "Assets, statutory checks and maintenance logs; no care notes.",
    scopeKind: "none",
    permissions: [
      "operations.premises.manage",
      "safety.incident.report",
      "scheduling.rota.read",
      "scheduling.timesheet.self",
      "workforce.self.read",
    ],
  },
  {
    key: "administrator",
    name: "Administrator or receptionist",
    description: "Enquiries, visitors, documents and appointments; read-only demographics.",
    scopeKind: "location",
    permissions: [
      "people.enquiry.manage",
      "people.demographics.read",
      "operations.visitors.manage",
      "operations.occupancy.manage",
      "safety.incident.report",
      "comms.message.send",
      "comms.letter.manage",
      "comms.notification.manage",
      "comms.visit_booking.manage",
      "comms.template.write",
      "platform.document.manage",
      "platform.search.use",
    ],
  },
  {
    key: "finance",
    name: "Finance",
    description:
      "Fees, invoicing, residents' money oversight, payroll export, budgets; no care notes.",
    scopeKind: "none",
    permissions: [
      "people.demographics.read",
      "finance.billing.manage",
      "finance.ledger.record",
      "finance.ledger.approve",
      "finance.reporting.read",
      "finance.payroll.export",
      "insights.dashboard.read",
    ],
  },
  {
    key: "hr",
    name: "HR, recruitment or training lead",
    description: "Recruitment, compliance files, training matrix, supervision; no care notes.",
    scopeKind: "none",
    permissions: [
      "workforce.recruitment.manage",
      "workforce.training.manage",
      "workforce.supervision.manage",
      "workforce.casework.manage",
      "workforce.competence.observe",
      "insights.dashboard.read",
      "platform.search.use",
    ],
  },
  {
    key: "quality_lead",
    name: "Quality and compliance lead",
    description:
      "Audits, policies, evidence, DSAR and breach registers, whistleblowing (anonymised).",
    scopeKind: "tenant",
    permissions: [
      "people.person.read",
      "care.plan.read",
      "care.note.read",
      "quality.audit.manage",
      "quality.policy.manage",
      "quality.evidence.manage",
      "quality.evidence_pack.compose",
      "quality.evidence_pack.release",
      "quality.statement_of_purpose.write",
      "comms.template.write",
      "comms.template.approve",
      "quality.dsar.manage",
      "safety.whistleblowing.read",
      "safety.complaint.manage",
      "safety.incident.read",
      "platform.audit.read",
      "platform.document.manage",
      "platform.retention.manage",
      "platform.search.use",
      "platform.search.archived",
      "platform.onboarding.read",
      "platform.dpia.read",
      "platform.dpia.prepare",
      "platform.dpia.sign",
      "insights.dashboard.read",
      "insights.report.manage",
    ],
  },
  {
    key: "external_professional",
    name: "External professional",
    description: "GP, district nurse, pharmacist, social worker: named people, time-limited.",
    scopeKind: "assigned",
    requiresExpiry: true,
    permissions: ["people.person.read", "care.plan.read", "care.note.read", "care.note.write"],
  },
  {
    key: "family_representative",
    name: "Family or representative",
    description:
      "Portal for one person: updates, consented care plan sections, invoices, messages.",
    scopeKind: "assigned",
    permissions: [
      "comms.portal.family",
      "comms.feed.read",
      "comms.notification.subscribe",
      "comms.visit_booking.request",
    ],
  },
  {
    key: "person_receiving_care",
    name: "Person receiving care",
    description: "Own portal: About Me, notes feed, preferences, feedback.",
    scopeKind: "self",
    permissions: ["comms.portal.self"],
  },
  {
    key: "agency_worker",
    name: "Agency or bank worker",
    description: "As care worker, auto-expiring at shift end plus 2 hours.",
    scopeKind: "assigned",
    requiresExpiry: true,
    permissions: pointOfCare,
  },
  {
    key: "inspector",
    name: "Inspector or auditor",
    description: "Read-only, time-boxed, watermarked evidence packs.",
    scopeKind: "none",
    requiresExpiry: true,
    permissions: ["quality.evidence.read"],
  },
];

export function builtinRole(key: string): BuiltinRole | undefined {
  return BUILTIN_ROLES.find((role) => role.key === key);
}
