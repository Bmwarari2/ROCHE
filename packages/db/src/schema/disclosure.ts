import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { person } from "./people";
import { location, tenant, tenantUser } from "./platform";

/**
 * Disclosure requests (SAFE-016; safety.md section 11, rules 38 to 44): coroner, Safeguarding Adults
 * Review, Domestic Homicide Review, police, solicitor and Access to Health Records Act requests about
 * one person, each with its legal basis, reviewed record by record by a person, approved by someone
 * other than the requester, and released as a stored pack. Items hold a record's table and id only,
 * never a copy of its content. `serious_incident` retention class (H-820).
 */

export const disclosureRequest = pgTable(
  "disclosure_request",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    personId: uuid("person_id").notNull(),
    /** The person's location when logged: whose managers may act on it. */
    locationId: uuid("location_id").notNull(),
    /** A `DisclosureType`. */
    type: text("type").notNull(),
    /** The legal basis relied on, as stated when logged. */
    legalBasis: text("legal_basis").notNull(),
    requesterName: text("requester_name").notNull(),
    requesterOrganisation: text("requester_organisation").notNull(),
    requesterReference: text("requester_reference"),
    /** For police and solicitor requests: what the request says the information is for. */
    statedPurpose: text("stated_purpose"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** A `DisclosureState`. */
    state: text("state").notNull().default("requested"),
    preparedBy: uuid("prepared_by"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    releasedBy: uuid("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    packSha256: text("pack_sha256"),
    packStorageKey: text("pack_storage_key"),
    /** Records found by the collector (and tables not searched, with reasons). */
    notSearched: text("not_searched").array().notNull().default(sql`'{}'::text[]`),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    /** Coroner: a Regulation 28 prevention of future deaths report received, and the response. */
    preventionReportOn: date("prevention_report_on", { mode: "string" }),
    preventionRespondedOn: date("prevention_responded_on", { mode: "string" }),
    ...mutableColumns(),
  },
  (t) => [
    unique("disclosure_request_tenant_id_id_key").on(t.tenantId, t.id),
    index("disclosure_request_state_idx").on(t.tenantId, t.state, t.receivedAt),
    foreignKey({
      name: "disclosure_request_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "disclosure_request_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    ...(["prepared_by", "decided_by", "released_by"] as const).map((col) =>
      foreignKey({
        name: `disclosure_request_${col}_fk`,
        columns: [
          t.tenantId,
          col === "prepared_by" ? t.preparedBy : col === "decided_by" ? t.decidedBy : t.releasedBy,
        ],
        foreignColumns: [tenantUser.tenantId, tenantUser.id],
      }),
    ),
    check(
      "disclosure_request_type",
      sql`type IN ('coroner', 'safeguarding_adults_review', 'domestic_homicide_review', 'police', 'solicitor', 'access_to_health_records')`,
    ),
    check(
      "disclosure_request_state",
      sql`state IN ('requested', 'prepared', 'approved', 'released', 'refused', 'withdrawn')`,
    ),
    check(
      "disclosure_request_text",
      sql`char_length(btrim(legal_basis)) BETWEEN 10 AND 500
        AND char_length(btrim(requester_name)) BETWEEN 1 AND 200
        AND char_length(btrim(requester_organisation)) BETWEEN 1 AND 200
        AND (requester_reference IS NULL OR char_length(btrim(requester_reference)) BETWEEN 1 AND 100)
        AND (stated_purpose IS NULL OR char_length(btrim(stated_purpose)) BETWEEN 3 AND 2000)
        AND (reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 2000)`,
    ),
    check(
      "disclosure_request_purpose",
      sql`type NOT IN ('police', 'solicitor') OR state IN ('requested', 'withdrawn') OR stated_purpose IS NOT NULL`,
    ),
    check(
      "disclosure_request_steps",
      sql`(state = 'requested' OR state = 'withdrawn' OR state = 'refused' OR (prepared_by IS NOT NULL AND prepared_at IS NOT NULL))
        AND (state NOT IN ('approved', 'released', 'refused') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
        AND (state NOT IN ('refused', 'withdrawn') OR reason IS NOT NULL)
        AND (state = 'released') = (released_by IS NOT NULL AND released_at IS NOT NULL)`,
    ),
    // The approver is never the person who logged the request (separation of duties).
    check(
      "disclosure_request_approver",
      sql`decided_by IS NULL OR decided_by IS DISTINCT FROM created_by`,
    ),
    check(
      "disclosure_request_pack",
      sql`(pack_sha256 IS NULL) = (pack_storage_key IS NULL)
        AND (pack_sha256 IS NULL) = (state <> 'released')
        AND (pack_sha256 IS NULL OR pack_sha256 ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "disclosure_request_prevention",
      sql`(prevention_report_on IS NULL OR type = 'coroner')
        AND (prevention_responded_on IS NULL OR (prevention_report_on IS NOT NULL AND prevention_responded_on >= prevention_report_on))`,
    ),
  ],
);

/** One record found for a request and the decision a person made about it (as `dsar_item`). */
export const disclosureItem = pgTable(
  "disclosure_item",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    requestId: uuid("request_id").notNull(),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    decision: text("decision").notNull().default("pending"),
    redactedFields: text("redacted_fields").array().notNull().default(sql`'{}'::text[]`),
    reason: text("reason"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    contentSha256: text("content_sha256"),
    ...mutableColumns(),
  },
  (t) => [
    unique("disclosure_item_tenant_id_id_key").on(t.tenantId, t.id),
    unique("disclosure_item_record_key").on(t.tenantId, t.requestId, t.tableName, t.recordId),
    index("disclosure_item_request_idx").on(t.tenantId, t.requestId, t.decision),
    foreignKey({
      name: "disclosure_item_request_fk",
      columns: [t.tenantId, t.requestId],
      foreignColumns: [disclosureRequest.tenantId, disclosureRequest.id],
    }),
    foreignKey({
      name: "disclosure_item_reviewed_by_fk",
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "disclosure_item_decision",
      sql`decision IN ('pending', 'disclose', 'redact', 'withhold')`,
    ),
    check(
      "disclosure_item_reviewed",
      sql`(decision = 'pending') = (reviewed_by IS NULL AND reviewed_at IS NULL AND content_sha256 IS NULL)
        AND (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "disclosure_item_redaction",
      sql`(decision = 'redact') = (cardinality(redacted_fields) > 0)
        AND (decision IN ('pending', 'disclose') OR reason IS NOT NULL)`,
    ),
  ],
);
