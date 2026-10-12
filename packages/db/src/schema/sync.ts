import { sql } from "drizzle-orm";
import {
  check,
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
import { createdColumns, id, tenantId } from "./_columns";
import { person } from "./people";
import { location, tenantUser } from "./platform";
import { task } from "./work";

/**
 * Care mode devices and what the server keeps about them (docs/specs/care.md section 6, Device
 * integrity; hazards HZ-006, HZ-010, HZ-011 and HZ-040). A device is identified by its PowerSync
 * client id, an opaque UUID made with each new database, so one device id is one database and one
 * owner.
 */

/** Why a manager revoked a device (coded; no words leave the manager's screen). */
export const DEVICE_REVOCATION_REASONS = [
  "lost_or_stolen",
  "staff_left",
  "access_withdrawn",
  "replaced",
  "other",
] as const;
export type DeviceRevocationReason = (typeof DEVICE_REVOCATION_REASONS)[number];

/**
 * Which member of staff has used which device (part 1): written by the sync token route and by a
 * device report from the device, in the system's view only. A hold report's named owner counts only
 * when bound here; the earliest first sighting of a device floors a hold's start (HZ-010). A
 * revocation (part 2) marks every row of the device, and the token and upload routes then refuse
 * the device. Mutable without a version history: the revocation is audited.
 */
export const deviceBinding = pgTable(
  "device_binding",
  {
    id: id(),
    tenantId: tenantId(),
    /** The PowerSync client id the device sent (`x-harbour-device`), lower-case. */
    deviceId: uuid("device_id").notNull(),
    tenantUserId: uuid("tenant_user_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    /** `DEVICE_REVOCATION_REASONS`. */
    revocationReason: text("revocation_reason"),
    ...createdColumns(),
  },
  (t) => [
    unique("device_binding_tenant_id_id_key").on(t.tenantId, t.id),
    unique("device_binding_device_user_key").on(t.tenantId, t.deviceId, t.tenantUserId),
    foreignKey({
      name: "device_binding_user_fk",
      columns: [t.tenantId, t.tenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "device_binding_revoked_by_fk",
      columns: [t.tenantId, t.revokedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("device_binding_user_idx").on(t.tenantId, t.tenantUserId),
    check("device_binding_seen", sql`last_seen_at >= first_seen_at`),
    check(
      "device_binding_revocation",
      sql`(revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IN (${sqlList(DEVICE_REVOCATION_REASONS)}))`,
    ),
  ],
);

/** The stages of a device's deletion of unsent entries (`SYNC_DISCARD_STAGES` in contracts). */
export const DEVICE_DISCARD_STAGES = ["requested", "deleted", "failed"] as const;

/**
 * The entry ids each stage of a deletion record lists (part 3; the HZ-040 go-live blocker): one
 * append-only row per stage and entry, written with the stage's audit event, so "did this entry's
 * owner's device record deleting it?" is one indexed read instead of a scan of the tenant's
 * deletion events. `discard_id` is the deletion record's id (the `device_discard` audit resource).
 */
export const deviceDiscardEntry = pgTable(
  "device_discard_entry",
  {
    id: id(),
    tenantId: tenantId(),
    discardId: uuid("discard_id").notNull(),
    /** `DEVICE_DISCARD_STAGES`. */
    stage: text("stage").notNull(),
    entryId: uuid("entry_id").notNull(),
    /** Whose entries the deletion said they were (tenant_user), when the device knew. */
    ownerTenantUserId: uuid("owner_tenant_user_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    unique("device_discard_entry_tenant_id_id_key").on(t.tenantId, t.id),
    unique("device_discard_entry_stage_key").on(t.tenantId, t.discardId, t.stage, t.entryId),
    foreignKey({
      name: "device_discard_entry_owner_fk",
      columns: [t.tenantId, t.ownerTenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("device_discard_entry_entry_idx").on(t.tenantId, t.entryId, t.ownerTenantUserId),
    check("device_discard_entry_stage", sql`stage IN (${sqlList(DEVICE_DISCARD_STAGES)})`),
  ],
);

/** The tables a device writes care entries to (`DEVICE_WRITABLE_TABLES` in packages/sync). */
export const REFUSED_ENTRY_TABLES = [
  "care_note",
  "observation",
  "body_map_mark",
  "activity_record",
  "visit_log",
] as const;

/**
 * The server's copy of a care entry the API refused from a device (part 5; HZ-006): what the device
 * held, why it was refused, who wrote it and the review task it joined, so a refused entry is never
 * only on one phone. Written in the system's view only, once per entry id; read like the care
 * record it would have been (the person's scope). Append-only.
 */
export const refusedEntry = pgTable(
  "refused_entry",
  {
    id: id(),
    tenantId: tenantId(),
    /** The entry's own id, made on the device (the id it was uploaded with). */
    entryId: uuid("entry_id").notNull(),
    /** `REFUSED_ENTRY_TABLES`. */
    recordTable: text("record_table").notNull(),
    personId: uuid("person_id"),
    locationId: uuid("location_id"),
    /** The entry's columns as the device held them, JSON. */
    payload: jsonb("payload").notNull(),
    httpStatus: integer("http_status"),
    refusalCode: text("refusal_code").notNull(),
    refusalMessage: text("refusal_message"),
    refusedAt: timestamp("refused_at", { withTimezone: true }).notNull(),
    /** Who wrote the entry (the uploader, or the owner of a handed-over entry). */
    authorTenantUserId: uuid("author_tenant_user_id").notNull(),
    deviceId: uuid("device_id"),
    reviewTaskId: uuid("review_task_id"),
    ...createdColumns(),
  },
  (t) => [
    unique("refused_entry_tenant_id_id_key").on(t.tenantId, t.id),
    unique("refused_entry_entry_key").on(t.tenantId, t.entryId),
    foreignKey({
      name: "refused_entry_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "refused_entry_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: "refused_entry_author_fk",
      columns: [t.tenantId, t.authorTenantUserId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "refused_entry_task_fk",
      columns: [t.tenantId, t.reviewTaskId],
      foreignColumns: [task.tenantId, task.id],
    }),
    index("refused_entry_person_idx").on(t.tenantId, t.personId, t.refusedAt),
    check("refused_entry_table", sql`record_table IN (${sqlList(REFUSED_ENTRY_TABLES)})`),
    check("refused_entry_payload", sql`jsonb_typeof(payload) = 'object'`),
    check("refused_entry_code", sql`refusal_code ~ '^[a-z0-9_]{1,80}$'`),
    check("refused_entry_status", sql`http_status IS NULL OR http_status BETWEEN 100 AND 599`),
  ],
);
