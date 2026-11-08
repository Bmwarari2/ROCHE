import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";

/**
 * Reporting lines for staff (ADR-0137; workforce.md section 3, rule 7): who line manages whom and
 * which staff teams there are, with their leads. Kept with history: a line or a membership ends on
 * a date and a new one starts, so who managed whom on a day can be shown. Maintained by
 * organisation-wide holders of `workforce.staff_file.manage` (HR). A line manager's current direct
 * reports and a team lead's current team widen the scope of the development permissions they
 * already hold (app.development_scope_members_for, migration 0162); the relationship never grants a
 * permission by itself. Retention: as the staff file (`staff_file.to_75th_birthday`).
 */

const memberRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/** A member's line manager from one day, until the day before `validTo` (null while current). */
export const staffLineManager = pgTable(
  "staff_line_manager",
  {
    id: id(),
    tenantId: tenantId(),
    workerId: uuid("worker_id").notNull(),
    managerId: uuid("manager_id").notNull(),
    validFrom: date("valid_from").notNull(),
    /** The day the line ended (exclusive); null while it is current. */
    validTo: date("valid_to"),
    ...mutableColumns(),
  },
  (t) => [
    unique("staff_line_manager_tenant_id_id_key").on(t.tenantId, t.id),
    memberRef("staff_line_manager_worker_fk", t, t.workerId),
    memberRef("staff_line_manager_manager_fk", t, t.managerId),
    index("staff_line_manager_manager_idx").on(t.tenantId, t.managerId),
    uniqueIndex("staff_line_manager_current_key")
      .on(t.tenantId, t.workerId)
      .where(sql`valid_to IS NULL AND deleted_at IS NULL`),
    check("staff_line_manager_not_self", sql`manager_id <> worker_id`),
    check("staff_line_manager_dates", sql`valid_to IS NULL OR valid_to > valid_from`),
  ],
);

/** A staff team: a name, optionally the home it belongs to; archived rather than deleted. */
export const staffTeam = pgTable(
  "staff_team",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    locationId: uuid("location_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("staff_team_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "staff_team_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    uniqueIndex("staff_team_name_key")
      .on(t.tenantId, sql`lower(${t.name})`)
      .where(sql`archived_at IS NULL AND deleted_at IS NULL`),
    check("staff_team_name", sql`length(btrim(name)) BETWEEN 2 AND 120`),
  ],
);

/** A member of a team from one day, until the day before `validTo`; `isLead` marks its leads. */
export const staffTeamMember = pgTable(
  "staff_team_member",
  {
    id: id(),
    tenantId: tenantId(),
    teamId: uuid("team_id").notNull(),
    memberId: uuid("member_id").notNull(),
    isLead: boolean("is_lead").notNull().default(false),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    ...mutableColumns(),
  },
  (t) => [
    unique("staff_team_member_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "staff_team_member_team_fk",
      columns: [t.tenantId, t.teamId],
      foreignColumns: [staffTeam.tenantId, staffTeam.id],
    }),
    memberRef("staff_team_member_member_fk", t, t.memberId),
    index("staff_team_member_member_idx").on(t.tenantId, t.memberId),
    uniqueIndex("staff_team_member_current_key")
      .on(t.tenantId, t.teamId, t.memberId)
      .where(sql`valid_to IS NULL AND deleted_at IS NULL`),
    check("staff_team_member_dates", sql`valid_to IS NULL OR valid_to > valid_from`),
  ],
);
