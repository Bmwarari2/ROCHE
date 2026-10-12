import { pgEnum } from "drizzle-orm/pg-core";

export const nation = pgEnum("nation", ["england", "wales", "scotland", "northern_ireland"]);

export const regulator = pgEnum("regulator", ["cqc", "ciw", "care_inspectorate", "rqia", "ofsted"]);

export const serviceType = pgEnum("service_type", [
  "residential",
  "nursing",
  "supported_living",
  "domiciliary",
  "complex_care",
  "live_in",
  "respite",
  "day_service",
  "childrens_home",
]);

export const legalForm = pgEnum("legal_form", [
  "limited_company",
  "charity",
  "community_interest_company",
  "partnership",
  "sole_trader",
  "public_body",
  "franchise",
]);

export const tenantStatus = pgEnum("tenant_status", [
  "onboarding",
  "active",
  "suspended",
  "closed",
]);

export const terminology = pgEnum("terminology", ["resident", "client", "person_we_support"]);

export const tenantUserStatus = pgEnum("tenant_user_status", [
  "invited",
  "active",
  "suspended",
  "left",
]);

/** Who a role may act on (section 4 attribute-based scoping). */
export const scopeKind = pgEnum("scope_kind", ["tenant", "location", "assigned", "self", "none"]);

/**
 * The person lifecycle (docs/specs/people.md rule 1; `PERSON_STATUSES` in packages/domain). New
 * values are added with `ALTER TYPE ... ADD VALUE` (expand only): a device one schema version
 * behind never sees `pre_admission` or `not_admitted` people, because nobody is assigned to them.
 */
export const personStatus = pgEnum("person_status", [
  "enquiry",
  "pre_admission",
  "active",
  "on_leave",
  "in_hospital",
  "discharged",
  "deceased",
  "archived",
  "not_admitted",
]);

/** HZ-007: "no known allergies" is a recorded fact, distinct from "not yet asked". */
export const allergyStatus = pgEnum("allergy_status", [
  "unknown",
  "no_known_allergies",
  "has_allergies",
]);

export const contactRole = pgEnum("contact_role", [
  "next_of_kin",
  "lpa_health_welfare",
  "lpa_property_finance",
  "deputy",
  "imca",
  "advocate",
  "appointee",
  "gp",
  "social_worker",
  "other",
]);

export const placementType = pgEnum("placement_type", ["permanent", "respite", "trial", "package"]);

export const notificationSeverity = pgEnum("notification_severity", ["info", "warning", "urgent"]);

export const auditOutcome = pgEnum("audit_outcome", ["success", "denied", "error"]);
