import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";
import { staffProfile } from "./workforce";

/**
 * The Thapsus-HR link (integrations.md section 11.3; ADR-0126; slice 87, migration 0141). The
 * connection itself is the `integrations.hr_link` row of `integration_connection`; these tables
 * hold the identifier mapping (Thapsus-HR has no external identifier columns), the sync position
 * and the outbound delivery log. Identifiers only: names, emails and dates of birth stay in the
 * staff file, never here (section 11.8).
 */

export const HR_LINK_PORT = "integrations.hr_link";
export const HR_LINK_STATES = ["linked", "review", "rejected"] as const;
export const HR_MATCH_METHODS = [
  "employee_number",
  "email_and_birth_date",
  "manual",
  // A starter this product created in Thapsus-HR, linked by the identifier Thapsus-HR returned.
  "starter",
] as const;
export const HR_REVIEW_REASONS = ["conflict", "ambiguous", "already_linked", "no_match"] as const;
export const HR_SYNC_KINDS = ["employees", "locations", "absences", "rates"] as const;
export const HR_DELIVERY_KINDS = ["starter", "shift", "clock_event", "pay_units"] as const;
export const HR_DELIVERY_STATES = ["pending", "sent", "failed", "refused"] as const;

const ref = (
  name: string,
  t: { tenantId: AnyPgColumn },
  column: AnyPgColumn,
  target: { tenantId: AnyPgColumn; id: AnyPgColumn },
) =>
  foreignKey({ name, columns: [t.tenantId, column], foreignColumns: [target.tenantId, target.id] });

/** Thapsus-HR's identifiers: short, opaque, never free text. */
const HR_ID = sql.raw(`'^[A-Za-z0-9_-]{1,64}$'`);

export const hrPersonLink = pgTable(
  "hr_person_link",
  {
    id: id(),
    tenantId: tenantId(),
    hrEmployeeId: text("hr_employee_id").notNull(),
    employeeNumber: text("employee_number"),
    /** The staff file it is linked to, or the candidate a person is asked to confirm. */
    staffProfileId: uuid("staff_profile_id"),
    state: text("state").notNull(),
    matchMethod: text("match_method"),
    reviewReason: text("review_reason"),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** The earliest leaving date Thapsus-HR has given (rule 8): a later sync never moves it on. */
    leavingOn: date("leaving_on"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("hr_person_link_tenant_id_id_key").on(t.tenantId, t.id),
    unique("hr_person_link_employee_key").on(t.tenantId, t.hrEmployeeId),
    uniqueIndex("hr_person_link_staff_key")
      .on(t.tenantId, t.staffProfileId)
      .where(sql`state = 'linked' AND deleted_at IS NULL`),
    index("hr_person_link_review_idx").on(t.tenantId, t.state),
    ref("hr_person_link_staff_profile_fk", t, t.staffProfileId, staffProfile),
    ref("hr_person_link_confirmed_by_fk", t, t.confirmedBy, tenantUser),
    check(
      "hr_person_link_values",
      sql`state IN (${sqlList(HR_LINK_STATES)})
        AND (match_method IS NULL OR match_method IN (${sqlList(HR_MATCH_METHODS)}))
        AND (review_reason IS NULL OR review_reason IN (${sqlList(HR_REVIEW_REASONS)}))
        AND hr_employee_id ~ ${HR_ID}
        AND (employee_number IS NULL OR employee_number ~ '^[A-Za-z0-9_/-]{1,40}$')`,
    ),
    check(
      "hr_person_link_state",
      sql`(state <> 'linked' OR (staff_profile_id IS NOT NULL AND match_method IS NOT NULL AND review_reason IS NULL))
        AND (state <> 'review' OR (review_reason IS NOT NULL AND match_method IS NULL))
        AND (match_method IS DISTINCT FROM 'manual' OR confirmed_by IS NOT NULL)
        AND ((confirmed_by IS NULL) = (confirmed_at IS NULL))`,
    ),
  ],
);

export const hrLocationLink = pgTable(
  "hr_location_link",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    hrLocationId: text("hr_location_id").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("hr_location_link_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("hr_location_link_location_key")
      .on(t.tenantId, t.locationId)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex("hr_location_link_hr_key")
      .on(t.tenantId, t.hrLocationId)
      .where(sql`deleted_at IS NULL`),
    ref("hr_location_link_location_fk", t, t.locationId, location),
    check("hr_location_link_hr_id", sql`hr_location_id ~ ${HR_ID}`),
  ],
);

export const hrSyncState = pgTable(
  "hr_sync_state",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    cursor: text("cursor"),
    lastGoodSyncAt: timestamp("last_good_sync_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** An opaque code (`unavailable`, `rate_limited`, `not_uk_host`), never a message. */
    lastErrorCode: text("last_error_code"),
    failures: integer("failures").notNull().default(0),
    ...mutableColumns(),
  },
  (t) => [
    unique("hr_sync_state_tenant_id_id_key").on(t.tenantId, t.id),
    unique("hr_sync_state_kind_key").on(t.tenantId, t.kind),
    check(
      "hr_sync_state_values",
      sql`kind IN (${sqlList(HR_SYNC_KINDS)})
        AND (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,40}$')
        AND (cursor IS NULL OR char_length(cursor) <= 512)
        AND failures >= 0`,
    ),
  ],
);

export const hrDelivery = pgTable(
  "hr_delivery",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    /** This product's record (the staff file for a starter, the shift, the clock event). */
    harbourRef: uuid("harbour_ref").notNull(),
    hrId: text("hr_id"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("hr_delivery_tenant_id_id_key").on(t.tenantId, t.id),
    unique("hr_delivery_ref_key").on(t.tenantId, t.kind, t.harbourRef),
    unique("hr_delivery_idempotency_key").on(t.tenantId, t.idempotencyKey),
    index("hr_delivery_due_idx")
      .on(t.tenantId, t.nextAttemptAt)
      .where(sql`state IN ('pending', 'failed')`),
    check(
      "hr_delivery_values",
      sql`kind IN (${sqlList(HR_DELIVERY_KINDS)}) AND state IN (${sqlList(HR_DELIVERY_STATES)})
        AND (hr_id IS NULL OR hr_id ~ ${HR_ID})
        AND (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,40}$')
        AND attempts >= 0
        AND ((state = 'sent') = (sent_at IS NOT NULL AND hr_id IS NOT NULL))`,
    ),
  ],
);
