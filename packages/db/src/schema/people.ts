import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { id, mutableColumns, searchVector, tenantId } from "./_columns";
import { allergyStatus, contactRole, personStatus, placementType } from "./enums";
import { admissionDecision } from "./people-lifecycle";
import { document, location, service, tenant, tenantUser } from "./platform";
import { sampleBatch } from "./sample-data";

/** `ROOM_STATUSES` in packages/domain (occupancy.ts): a room is held after a death until cleared. */
export const ROOM_STATUS_SQL = sqlList(["available", "out_of_service", "awaiting_clearance"]);

/** HZ-023: an empty list of communication needs is "not recorded" until someone confirms "none". */
export const COMMUNICATION_NEEDS_STATUS_SQL = sqlList([
  "not_recorded",
  "none_identified",
  "recorded",
]);

/** `BREAK_GLASS_REASON_CODES` in packages/domain (break-glass-report.ts). */
export const BREAK_GLASS_REASON_SQL = sqlList([
  "emergency_care",
  "covering_another_area",
  "safeguarding",
  "incident_or_complaint",
  "request_from_professional",
  "other",
]);

/**
 * Service-user lifecycle (`people` bounded context, master prompt section 9.2).
 *
 * Besides tenant isolation, every table here is restricted by the person-scope policy: a user sees
 * a person only if their role is tenant-wide, the person is at one of their locations, they are
 * assigned to the person, or they hold an open break-glass record (section 4). See ADR-0002.
 */

export const room = pgTable(
  "room",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    locationId: uuid("location_id").notNull(),
    label: text("label").notNull(),
    unitName: text("unit_name"),
    floor: text("floor"),
    beds: integer("beds").notNull().default(1),
    ensuite: boolean("ensuite").notNull().default(false),
    /** `available`, `out_of_service` or `awaiting_clearance` (held after a death, people.md rule 6). */
    status: text("status").notNull().default("available"),
    ...mutableColumns(),
  },
  (t) => [
    unique("room_tenant_id_id_key").on(t.tenantId, t.id),
    unique("room_location_label_key").on(t.tenantId, t.locationId, t.label),
    foreignKey({
      name: "room_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check("room_status", sql`status IN (${ROOM_STATUS_SQL})`),
    check("room_beds", sql`beds >= 1`),
  ],
);

/** MODS-aligned person record (section 18 `person`). */
export const person = pgTable(
  "person",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** Primary location, used for location-scoped access. */
    locationId: uuid("location_id").notNull(),
    status: personStatus("status").notNull().default("enquiry"),
    /** Validated with the modulus 11 check digit; the consistent identifier but never the only one. */
    nhsNumber: text("nhs_number"),
    localIdentifier: text("local_identifier"),
    title: text("title"),
    givenName: text("given_name").notNull(),
    familyName: text("family_name").notNull(),
    preferredName: text("preferred_name"),
    dateOfBirth: date("date_of_birth"),
    /** NHS Data Dictionary person stated sex/gender codes. */
    sexCode: text("sex_code"),
    genderIdentity: text("gender_identity"),
    /** NHS Data Dictionary ethnic category code (A-Z, 99). */
    ethnicCategoryCode: text("ethnic_category_code"),
    religion: text("religion"),
    firstLanguage: text("first_language"),
    interpreterRequired: boolean("interpreter_required").notNull().default(false),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    town: text("town"),
    postcode: text("postcode"),
    gpPracticeOdsCode: text("gp_practice_ods_code"),
    legalStatus: text("legal_status"),
    photoDocumentId: uuid("photo_document_id"),
    /** Display cache of the current room, maintained by the admission workflow; synced to devices. */
    roomLabel: text("room_label"),
    /** Search vectors: the names (break-glass search matches these alone) and the room. */
    searchNames: searchVector(
      "search_names",
      sql`app.search_vector(given_name || ' ' || family_name || ' ' || coalesce(preferred_name, ''))`,
    ),
    searchRoom: searchVector("search_room", sql`app.search_vector(room_label)`),
    /** Accessible Information Standard needs: [{ code (SNOMED CT), display, preferredFormat }]. */
    communicationNeeds: jsonb("communication_needs").notNull().default(sql`'[]'::jsonb`),
    /**
     * `not_recorded`, `none_identified` (a positive statement, with who confirmed it and when) or
     * `recorded`. Until it is confirmed, an empty list means "not recorded", never "none" (HZ-023).
     */
    communicationNeedsStatus: text("communication_needs_status").notNull().default("not_recorded"),
    communicationNeedsConfirmedBy: uuid("communication_needs_confirmed_by"),
    communicationNeedsConfirmedAt: timestamp("communication_needs_confirmed_at", {
      withTimezone: true,
    }),
    allergyStatus: allergyStatus("allergy_status").notNull().default("unknown"),
    /**
     * Who set the allergy status and when ("no known allergies" is a positive statement, HZ-007).
     * Set by a trigger whenever the status changes; never the last person to edit the row.
     */
    allergyStatusConfirmedBy: uuid("allergy_status_confirmed_by"),
    allergyStatusConfirmedAt: timestamp("allergy_status_confirmed_at", { withTimezone: true }),
    nationalDataOptOut: boolean("national_data_opt_out").notNull().default(false),
    deceasedAt: timestamp("deceased_at", { withTimezone: true }),
    dischargedAt: timestamp("discharged_at", { withTimezone: true }),
    /**
     * When the current status began; for a discharge or death, when the person left or died
     * (people.md rules 2 and 3). Kept in step by a trigger when only `status` is written.
     */
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Sample data mode (rule 29; HZ-072): an invented person loaded with a sample batch. */
    isSample: boolean("is_sample").notNull().default(false),
    sampleBatchId: uuid("sample_batch_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("person_tenant_id_id_key").on(t.tenantId, t.id),
    unique("person_tenant_nhs_number_key").on(t.tenantId, t.nhsNumber),
    foreignKey({
      name: "person_sample_batch_fk",
      columns: [t.tenantId, t.sampleBatchId],
      foreignColumns: [sampleBatch.tenantId, sampleBatch.id],
    }),
    check("person_sample", sql`is_sample = (sample_batch_id IS NOT NULL)`),
    foreignKey({
      name: "person_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "person_photo_fk",
      columns: [t.tenantId, t.photoDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    foreignKey({
      name: "person_communication_confirmed_by_fk",
      columns: [t.tenantId, t.communicationNeedsConfirmedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "person_allergy_confirmed_by_fk",
      columns: [t.tenantId, t.allergyStatusConfirmedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "person_communication_needs_status",
      sql`communication_needs_status IN (${COMMUNICATION_NEEDS_STATUS_SQL})`,
    ),
    check(
      "person_communication_none_identified",
      sql`communication_needs_status <> 'none_identified' OR (communication_needs = '[]'::jsonb
        AND communication_needs_confirmed_by IS NOT NULL AND communication_needs_confirmed_at IS NOT NULL)`,
    ),
    index("person_tenant_location_idx").on(t.tenantId, t.locationId),
    index("person_family_name_idx").on(t.tenantId, t.familyName),
  ],
);

/** Composite (tenant_id, person_id) reference so a child row can never point across tenants. */
const personFk = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

export const contact = pgTable(
  "contact",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    role: contactRole("role").notNull(),
    givenName: text("given_name").notNull(),
    familyName: text("family_name").notNull(),
    relationship: text("relationship"),
    phone: text("phone"),
    email: text("email"),
    addressLine1: text("address_line1"),
    town: text("town"),
    postcode: text("postcode"),
    isNextOfKin: boolean("is_next_of_kin").notNull().default(false),
    /** Office of the Public Guardian or court reference for LPAs and deputyships. */
    authorityReference: text("authority_reference"),
    authorityDocumentId: uuid("authority_document_id"),
    validUntil: date("valid_until"),
    /** For a deputy: `personal_welfare`, `property_affairs` or `both` (sharing, people.md rule 13). */
    authorityScope: text("authority_scope"),
    notes: text("notes"),
    ...mutableColumns(),
  },
  (t) => [
    // Lets visits and care plan sign-offs reference one of the same person's contacts through a
    // composite key (ADR-0002).
    unique("contact_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personFk("contact_person_fk", t),
    check(
      "contact_authority_scope",
      sql`authority_scope IS NULL OR authority_scope IN ('personal_welfare', 'property_affairs', 'both')`,
    ),
    index("contact_person_idx").on(t.tenantId, t.personId),
  ],
);

export const allergy = pgTable(
  "allergy",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    substance: text("substance").notNull(),
    snomedCode: text("snomed_code"),
    category: text("category").notNull().default("other"),
    reaction: text("reaction"),
    severity: text("severity").notNull().default("unknown"),
    status: text("status").notNull().default("active"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedBy: uuid("verified_by"),
    ...mutableColumns(),
  },
  (t) => [personFk("allergy_person_fk", t), index("allergy_person_idx").on(t.tenantId, t.personId)],
);

/** One person, many placements over time (respite then permanent) under one record. */
export const placement = pgTable(
  "placement",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    roomId: uuid("room_id"),
    type: placementType("type").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    endReason: text("end_reason"),
    dependencyCategory: text("dependency_category"),
    /** A trial placement's agreed end and the day its review was held (people.md rules 5 and 8). */
    trialEndsOn: date("trial_ends_on"),
    trialReviewedOn: date("trial_reviewed_on"),
    /** Funding flags for the review tracker and exit notifications; detail moves to finance (Phase 3). */
    localAuthorityFunded: boolean("local_authority_funded").notNull().default(false),
    nhsFunded: boolean("nhs_funded").notNull().default(false),
    /** The decision to admit this placement rests on. */
    admissionDecisionId: uuid("admission_decision_id"),
    ...mutableColumns(),
  },
  (t) => [
    unique("placement_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personFk("placement_person_fk", t),
    foreignKey({
      name: "placement_admission_decision_fk",
      columns: [t.tenantId, t.personId, t.admissionDecisionId],
      foreignColumns: [
        admissionDecision.tenantId,
        admissionDecision.personId,
        admissionDecision.id,
      ],
    }),
    check("placement_trial_end", sql`trial_ends_on IS NULL OR trial_ends_on > start_date`),
    foreignKey({
      name: "placement_service_fk",
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [service.tenantId, service.id],
    }),
    foreignKey({
      name: "placement_room_fk",
      columns: [t.tenantId, t.roomId],
      foreignColumns: [room.tenantId, room.id],
    }),
    index("placement_person_idx").on(t.tenantId, t.personId),
  ],
);

/** PRSB About Me v2, authored by the person or their carer. */
export const aboutMe = pgTable(
  "about_me",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    sections: jsonb("sections").notNull().default(sql`'{}'::jsonb`),
    authoredByPerson: boolean("authored_by_person").notNull().default(false),
    ...mutableColumns(),
  },
  (t) => [
    unique("about_me_person_key").on(t.tenantId, t.personId),
    personFk("about_me_person_fk", t),
  ],
);

/** Care workers see assigned people only; agency assignments expire (section 4). */
export const personAssignment = pgTable(
  "person_assignment",
  {
    id: id(),
    tenantId: tenantId(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    personId: uuid("person_id").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    personFk("person_assignment_person_fk", t),
    foreignKey({
      name: "person_assignment_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("person_assignment_user_idx").on(t.tenantId, t.tenantUserId),
  ],
);

/**
 * Break-glass access: an authorised manager opens a record outside their scope with a typed
 * justification. It alerts the Registered Manager and the data protection lead and is reported
 * weekly (section 4). Access lapses at `expires_at`.
 */
export const breakGlassEvent = pgTable(
  "break_glass_event",
  {
    id: id(),
    tenantId: tenantId(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    /**
     * `open` (a record opened outside scope) or `search` (a break-glass search, platform-completions.md
     * rule 9): a search names no one person, and its `expires_at` is when it ran, so it opens nothing.
     */
    kind: text("kind").notNull().default("open"),
    /** The person opened; null for a search, whose people shown are in its audit event. */
    personId: uuid("person_id"),
    /**
     * For a search, the homes whose people were shown (location ids, for the weekly report);
     * empty for an opening, whose home is the person's.
     */
    shownLocationIds: uuid("shown_location_ids").array().notNull().default(sql`'{}'::uuid[]`),
    justification: text("justification").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    reviewOutcome: text("review_outcome"),
    /** `BREAK_GLASS_REASON_CODES`, for the weekly report; the typed justification stays. */
    reasonCode: text("reason_code"),
    ...mutableColumns(),
  },
  (t) => [
    personFk("break_glass_person_fk", t),
    check(
      "break_glass_kind",
      sql`kind IN ('open', 'search') AND (kind = 'open') = (person_id IS NOT NULL)
        AND (kind = 'open' OR expires_at = opened_at)`,
    ),
    check(
      "break_glass_reason_code",
      sql`reason_code IS NULL OR reason_code IN (${BREAK_GLASS_REASON_SQL})`,
    ),
    foreignKey({
      name: "break_glass_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("break_glass_user_person_idx").on(t.tenantId, t.tenantUserId, t.personId),
  ],
);
