import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, optionalTenantId, tenantId } from "./_columns";
import {
  auditOutcome,
  legalForm,
  nation,
  notificationSeverity,
  regulator,
  scopeKind,
  serviceType,
  tenantStatus,
  tenantUserStatus,
  terminology,
} from "./enums";
// A cycle (people.ts reads tenant, location and user from here); the reference below is read only
// when the table's constraints are built, after both modules have loaded.
import { person } from "./people";

/**
 * Platform core (`platform` bounded context, master prompt section 9.1).
 *
 * Every tenant-owned table carries `tenant_id`; Postgres row-level security (FORCE) restricts it to
 * `app.current_tenant_id()`. Child tables reference parents through composite (tenant_id, id)
 * foreign keys so a row can never point at another tenant's record (referential checks bypass RLS,
 * so this is the guarantee, not a convenience). See ADR-0002.
 */

/** Optional layer above tenants for multi-provider organisations (section 4). */
export const tenantGroup = pgTable("tenant_group", {
  id: id(),
  name: text("name").notNull(),
  ...mutableColumns(),
});

export const tenant = pgTable(
  "tenant",
  {
    id: id(),
    groupId: uuid("group_id").references(() => tenantGroup.id),
    name: text("name").notNull(),
    legalName: text("legal_name").notNull(),
    cqcProviderId: text("cqc_provider_id"),
    legalForm: legalForm("legal_form").notNull(),
    vatRegistered: boolean("vat_registered").notNull().default(false),
    nation: nation("nation").notNull().default("england"),
    status: tenantStatus("status").notNull().default("onboarding"),
    brandName: text("brand_name"),
    /** Validated and contrast-adjusted (4.5:1 on white and black) before it is stored. */
    brandAccent: text("brand_accent"),
    logoDocumentId: uuid("logo_document_id"),
    terminology: terminology("terminology").notNull().default("resident"),
    dpoName: text("dpo_name"),
    dpoEmail: text("dpo_email"),
    caldicottGuardian: text("caldicott_guardian"),
    siro: text("siro"),
    ...mutableColumns(),
  },
  (t) => [
    unique("tenant_cqc_provider_id_key").on(t.cqcProviderId),
    check("tenant_brand_accent_hex", sql`brand_accent IS NULL OR brand_accent ~ '^#[0-9a-f]{6}$'`),
  ],
);

export const location = pgTable(
  "location",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    name: text("name").notNull(),
    regulator: regulator("regulator").notNull().default("cqc"),
    regulatorLocationId: text("regulator_location_id"),
    odsCode: text("ods_code"),
    nation: nation("nation").notNull().default("england"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    town: text("town"),
    postcode: text("postcode"),
    timezone: text("timezone").notNull().default("Europe/London"),
    phone: text("phone"),
    bedCapacity: integer("bed_capacity"),
    status: text("status").notNull().default("active"),
    /**
     * Location settings `downtime.mar_location` and `downtime.peep_location` (operations.md rule
     * 7): where the paper MAR and the PEEPs are kept, worded for the downtime pack. Seeded with
     * `DEFAULT_PAPER_MAR_LOCATION` and `DEFAULT_PEEP_LOCATION` (a test keeps them in step); the
     * Registered Manager replaces them with the real place.
     */
    downtimeMarLocation: text("downtime_mar_location").notNull().default("the paper MAR chart"),
    downtimePeepLocation: text("downtime_peep_location")
      .notNull()
      .default("the person's PEEP in the fire file"),
    /**
     * When and by whom a holder of `platform.location.manage` confirmed the two places; null while
     * the seeded wording stands, and again whenever a place changes without being confirmed.
     */
    downtimePlacesConfirmedAt: timestamp("downtime_places_confirmed_at", { withTimezone: true }),
    downtimePlacesConfirmedBy: uuid("downtime_places_confirmed_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("location_tenant_id_id_key").on(t.tenantId, t.id),
    index("location_tenant_id_idx").on(t.tenantId),
    check(
      "location_downtime_places",
      sql`char_length(btrim(downtime_mar_location)) BETWEEN 1 AND 200
        AND char_length(btrim(downtime_peep_location)) BETWEEN 1 AND 200
        AND (downtime_places_confirmed_at IS NULL) = (downtime_places_confirmed_by IS NULL)`,
    ),
    foreignKey({
      name: "location_downtime_places_confirmed_by_fk",
      columns: [t.tenantId, t.downtimePlacesConfirmedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
  ],
);

export const service = pgTable(
  "service",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    serviceType: serviceType("service_type").notNull(),
    status: text("status").notNull().default("active"),
    startedOn: date("started_on"),
    ...mutableColumns(),
  },
  (t) => [
    unique("service_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "service_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    index("service_tenant_location_idx").on(t.tenantId, t.locationId),
  ],
);

/**
 * A person's membership of a tenant. Identity, credentials and MFA live in the `auth` schema
 * (Better Auth); one identity can belong to several tenants (agency and bank workers).
 */
export const tenantUser = pgTable(
  "tenant_user",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    authUserId: text("auth_user_id"),
    displayName: text("display_name").notNull(),
    email: text("email").notNull(),
    jobTitle: text("job_title"),
    status: tenantUserStatus("status").notNull().default("invited"),
    isAgency: boolean("is_agency").notNull().default(false),
    /** MFA is mandatory for every role that can read care records (section 5.3). */
    mfaRequired: boolean("mfa_required").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("tenant_user_tenant_id_id_key").on(t.tenantId, t.id),
    unique("tenant_user_tenant_auth_user_key").on(t.tenantId, t.authUserId),
    unique("tenant_user_tenant_email_key").on(t.tenantId, t.email),
    index("tenant_user_auth_user_idx").on(t.authUserId),
  ],
);

/** Roles are per-tenant bundles of permissions plus a scope rule, versioned (section 4). */
export const role = pgTable(
  "role",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    scopeKind: scopeKind("scope_kind").notNull(),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    basedOnKey: text("based_on_key"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("role_tenant_id_id_key").on(t.tenantId, t.id),
    unique("role_tenant_key_key").on(t.tenantId, t.key),
  ],
);

export const roleAssignment = pgTable(
  "role_assignment",
  {
    id: id(),
    tenantId: tenantId(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    roleId: uuid("role_id").notNull(),
    /**
     * NULL means every location in the tenant for a role scoped to the organisation; a role scoped
     * to locations needs `organisation_wide` set to mean that (a trigger refuses it otherwise,
     * ADR-0071 review round 1, L2).
     */
    locationId: uuid("location_id"),
    /** A location role deliberately assigned across the whole organisation. */
    organisationWide: boolean("organisation_wide").notNull().default(false),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    /** Agency and visiting professionals always get an expiry. */
    validTo: timestamp("valid_to", { withTimezone: true }),
    reason: text("reason"),
    ...mutableColumns(),
  },
  (t) => [
    check(
      "role_assignment_organisation_wide",
      sql`NOT ${t.organisationWide} OR ${t.locationId} IS NULL`,
    ),
    foreignKey({
      name: "role_assignment_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "role_assignment_role_fk",
      columns: [t.tenantId, t.roleId],
      foreignColumns: [role.tenantId, role.id],
    }),
    foreignKey({
      name: "role_assignment_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    index("role_assignment_user_idx").on(t.tenantId, t.tenantUserId),
  ],
);

/** Delegation and acting-up are time-boxed grants, not role edits (section 4). */
export const accessGrant = pgTable(
  "access_grant",
  {
    id: id(),
    tenantId: tenantId(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    permissions: text("permissions").array().notNull(),
    /** The location the grant is for; NULL only for a grant marked `organisation_wide`. */
    locationId: uuid("location_id"),
    /** The grant reaches the whole organisation (ADR-0071 review round 1, L1). */
    organisationWide: boolean("organisation_wide").notNull().default(false),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    grantedBy: uuid("granted_by").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    check("access_grant_place", sql`(${t.locationId} IS NULL) = ${t.organisationWide}`),
    foreignKey({
      name: "access_grant_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "access_grant_granted_by_fk",
      columns: [t.tenantId, t.grantedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("access_grant_user_idx").on(t.tenantId, t.tenantUserId),
  ],
);

/** Per-tenant and per-location module switches; read through the OpenFeature provider. */
export const featureFlag = pgTable(
  "feature_flag",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    locationId: uuid("location_id"),
    flagKey: text("flag_key").notNull(),
    enabled: boolean("enabled").notNull(),
    value: jsonb("value"),
    ...mutableColumns(),
  },
  (t) => [
    unique("feature_flag_scope_key").on(t.tenantId, t.locationId, t.flagKey).nullsNotDistinct(),
    foreignKey({
      name: "feature_flag_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
  ],
);

/**
 * Append-only, tamper-evident audit trail (section 5.5). Each tenant's events form a SHA-256 hash
 * chain maintained by a trigger; the application role has INSERT and SELECT only. Rows hold opaque
 * identifiers, never personal data, apart from the typed justification where one is required.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: id(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    tenantId: optionalTenantId(),
    /** Position in the tenant's hash chain (commit order), set by the chain trigger. */
    chainPosition: bigint("chain_position", { mode: "number" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorTenantUserId: uuid("actor_tenant_user_id"),
    actorAuthUserId: text("actor_auth_user_id"),
    actorRoleKeys: text("actor_role_keys").array(),
    action: text("action").notNull(),
    outcome: auditOutcome("outcome").notNull().default("success"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    scope: jsonb("scope"),
    ip: inet("ip"),
    deviceId: text("device_id"),
    requestId: text("request_id"),
    reason: text("reason"),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    prevHash: text("prev_hash"),
    hash: text("hash"),
  },
  (t) => [
    index("audit_event_tenant_seq_idx").on(t.tenantId, t.seq),
    unique("audit_event_chain_position_key").on(t.tenantId, t.chainPosition).nullsNotDistinct(),
    index("audit_event_resource_idx").on(t.tenantId, t.resourceType, t.resourceId),
  ],
);

/**
 * Transactional outbox: modules publish domain events in the same transaction as the change; a
 * pg-boss relay delivers them (section 6, domain structure).
 */
export const outboxEvent = pgTable(
  "outbox_event",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [index("outbox_event_pending_idx").on(t.availableAt).where(sql`published_at IS NULL`)],
);

/** Escalation chains, e.g. an unacknowledged missed-visit alarm goes to on-call in 10 minutes. */
export const escalationChain = pgTable(
  "escalation_chain",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Ordered steps: { afterMinutes, targetRoleKey?, targetTenantUserId?, channels[] }. */
    steps: jsonb("steps").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("escalation_chain_tenant_id_id_key").on(t.tenantId, t.id),
    unique("escalation_chain_tenant_key_key").on(t.tenantId, t.key),
  ],
);

/** In-app notification centre. Push, email and SMS carry no personal data, only a link. */
export const notification = pgTable(
  "notification",
  {
    id: id(),
    tenantId: tenantId(),
    recipientTenantUserId: uuid("recipient_tenant_user_id").notNull(),
    kind: text("kind").notNull(),
    severity: notificationSeverity("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    channels: text("channels").array().notNull().default(sql`'{in_app}'::text[]`),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    /**
     * The person and the location the alert concerns, so a shift handover lists an urgent alert
     * at its location (care.md rule 8, HZ-018). Opaque references: the alert itself never names
     * the person in its title or body.
     */
    personId: uuid("person_id"),
    locationId: uuid("location_id"),
    dedupeKey: text("dedupe_key"),
    escalationChainId: uuid("escalation_chain_id"),
    escalationStep: integer("escalation_step").notNull().default(0),
    escalateAt: timestamp("escalate_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "notification_recipient_fk",
      columns: [t.tenantId, t.recipientTenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "notification_escalation_chain_fk",
      columns: [t.tenantId, t.escalationChainId],
      foreignColumns: [escalationChain.tenantId, escalationChain.id],
    }),
    foreignKey({
      name: "notification_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "notification_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    unique("notification_dedupe_key").on(t.tenantId, t.recipientTenantUserId, t.dedupeKey),
    // The urgent alerts a location's handover reads (care.md rule 8).
    index("notification_location_urgent_idx")
      .on(t.tenantId, t.locationId, t.createdAt)
      .where(sql`severity = 'urgent'`),
    index("notification_recipient_unread_idx")
      .on(t.tenantId, t.recipientTenantUserId, t.createdAt)
      .where(sql`read_at IS NULL`),
    index("notification_escalate_idx")
      .on(t.escalateAt)
      .where(sql`acknowledged_at IS NULL AND escalate_at IS NOT NULL`),
  ],
);

export const notificationPreference = pgTable(
  "notification_preference",
  {
    id: id(),
    tenantId: tenantId(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    quietHoursStart: time("quiet_hours_start"),
    quietHoursEnd: time("quiet_hours_end"),
    /** Per-kind channel choices; urgent safety notifications ignore quiet hours. */
    channels: jsonb("channels").notNull().default(sql`'{}'::jsonb`),
    ...mutableColumns(),
  },
  (t) => [
    unique("notification_preference_user_key").on(t.tenantId, t.tenantUserId),
    foreignKey({
      name: "notification_preference_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
  ],
);

/**
 * Forms and assessment engine. Global templates (tenant_id NULL) include the locked validated tools,
 * which tenants can use but never edit. Tenant templates are versioned; submissions pin the version.
 */
export const formTemplate = pgTable(
  "form_template",
  {
    id: id(),
    tenantId: optionalTenantId().references(() => tenant.id),
    key: text("key").notNull(),
    templateVersion: integer("template_version").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("form"),
    locked: boolean("locked").notNull().default(false),
    definition: jsonb("definition").notNull(),
    reviewCadenceDays: integer("review_cadence_days"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("form_template_key_version_key")
      .on(t.tenantId, t.key, t.templateVersion)
      .nullsNotDistinct(),
  ],
);

export const formSubmission = pgTable(
  "form_submission",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    templateId: uuid("template_id")
      .notNull()
      .references(() => formTemplate.id),
    templateKey: text("template_key").notNull(),
    templateVersion: integer("template_version").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    answers: jsonb("answers").notNull(),
    /** Stored with the calculation so the score can be reproduced and explained. */
    result: jsonb("result"),
    status: text("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [index("form_submission_subject_idx").on(t.tenantId, t.subjectType, t.subjectId)],
);

/**
 * Dated statutory figures (section 18). Application code never contains a rate; it reads this
 * table. Global rows (tenant_id NULL) are seeded from docs/specs/rates.md; tenants may add
 * overrides only where the figure is a tenant choice (e.g. ECM tolerance windows).
 */
export const rateTable = pgTable(
  "rate_table",
  {
    id: id(),
    tenantId: optionalTenantId().references(() => tenant.id),
    key: text("key").notNull(),
    value: numeric("value", { precision: 14, scale: 4 }).notNull(),
    unit: text("unit").notNull(),
    nation: text("nation").notNull().default("all"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    source: text("source").notNull(),
    verificationStatus: text("verification_status").notNull(),
    ...createdColumns(),
  },
  (t) => [index("rate_table_lookup_idx").on(t.key, t.nation, t.validFrom)],
);

/** Retention schedule defaults (section 5.1) seeded from docs/specs/retention.md. */
export const retentionClass = pgTable(
  "retention_class",
  {
    id: id(),
    tenantId: optionalTenantId().references(() => tenant.id),
    recordClass: text("record_class").notNull(),
    period: integer("period").notNull(),
    unit: text("unit").notNull(),
    trigger: text("trigger").notNull(),
    source: text("source").notNull(),
    notes: text("notes"),
    ...createdColumns(),
  },
  (t) => [unique("retention_class_key").on(t.tenantId, t.recordClass).nullsNotDistinct()],
);

/**
 * UK bank holidays by nation for working-day clocks, seeded from docs/specs/calendar.md. National
 * facts, not tenant data: there is no tenant column, everyone reads them and only the owner role
 * maintains them.
 */
export const bankHoliday = pgTable(
  "bank_holiday",
  {
    id: id(),
    nation: text("nation").notNull(),
    date: date("date").notNull(),
    name: text("name").notNull(),
  },
  (t) => [unique("bank_holiday_nation_date").on(t.nation, t.date)],
);

/** Versioned document store (section 9.1); content lives in S3 under SSE-KMS. */
export const document = pgTable(
  "document",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    category: text("category").notNull(),
    title: text("title").notNull(),
    retentionClass: text("retention_class").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    documentVersion: integer("document_version").notNull().default(1),
    previousVersionId: uuid("previous_version_id"),
    legalHold: boolean("legal_hold").notNull().default(false),
    /** What the document belongs to (for example a person, an incident or a policy). */
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    /**
     * Set for documents about a person, so they follow the person's scope. The composite foreign
     * key to person is added in SQL (migration 0010) to avoid a schema import cycle.
     */
    personId: uuid("person_id"),
    /** Display name only, made safe on upload; storage keys never contain it. */
    fileName: text("file_name"),
    /** `available`, `quarantined` (failed the malware scan) or `destroyed` (past retention). */
    status: text("status").notNull().default("available"),
    /** `clean`, `infected`, `unavailable` (scanner down: kept quarantined) or `not_scanned`. */
    scanStatus: text("scan_status").notNull().default("not_scanned"),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    /**
     * For a JPEG or PNG: whether the printed transfer pack can print it, decided once at upload with
     * the decoder the PDF uses (HZ-001, HZ-023). Null for other files and for images uploaded before
     * migration 0026, which are decided on first use and stored.
     */
    imagePrintable: boolean("image_printable"),
    ...mutableColumns(),
  },
  (t) => [
    unique("document_tenant_id_id_key").on(t.tenantId, t.id),
    index("document_person_idx").on(t.tenantId, t.personId),
    index("document_subject_idx").on(t.tenantId, t.subjectType, t.subjectId),
  ],
);

/**
 * Generic temporal history for mutable aggregates (section 6, database): a trigger copies the
 * previous row here on every UPDATE, so every demographic or plan edit is versioned.
 */
export const recordVersion = pgTable(
  "record_version",
  {
    id: id(),
    tenantId: optionalTenantId(),
    tableName: text("table_name").notNull(),
    recordId: uuid("record_id").notNull(),
    recordVersion: integer("record_version").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull().defaultNow(),
    changedBy: uuid("changed_by"),
    data: jsonb("data").notNull(),
  },
  (t) => [index("record_version_record_idx").on(t.tenantId, t.tableName, t.recordId)],
);

/**
 * Per-user request limits shared by every API instance (care.md section 6, Device integrity part
 * 7; platform.md): one row per member and limit, holding the recent hits (`[{ at, amount }]`, epoch
 * milliseconds) inside the limit's window, read and rewritten under a row lock. Operational: a row
 * holds at most a window's hits and is overwritten in place, never exported.
 */
export const requestQuota = pgTable(
  "request_quota",
  {
    id: id(),
    tenantId: tenantId(),
    /** The limit's name, for example `sync.reports` or `transfer_pack`. */
    quota: text("quota").notNull(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    hits: jsonb("hits").notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("request_quota_key").on(t.tenantId, t.quota, t.tenantUserId),
    foreignKey({
      name: "request_quota_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check("request_quota_hits", sql`jsonb_typeof(hits) = 'array'`),
  ],
);
