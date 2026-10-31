import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOGIN_ROLES, NOLOGIN_ROLES } from "../src/admin/roles";
import { createTestDatabase, type TestDatabase } from "./support/database";

/**
 * Guards that keep row-level security complete as the schema grows (hazard HZ-011, ADR-0002).
 * A new table without RLS, without FORCE, without a tenant policy, or with an UPDATE/DELETE grant
 * on an append-only table fails CI here.
 */

const APPEND_ONLY_TABLES = [
  "audit_event",
  "record_version",
  "workflow_transition",
  "document_signature",
  "destruction_certificate",
  "care_note",
  "observation",
  "body_map_mark",
  "assessment",
  "activity_record",
  "visit_log",
  "capacity_assessment",
  "best_interests_decision",
  "classifier_answer",
  "admission_decision",
  "review_record",
  "break_glass_weekly_report",
  "handover_item",
  "handover_note",
  "handover_acknowledgement",
  "device_discard_entry",
  "refused_entry",
  "device_session",
  "handed_over_entry",
  "device_discard_record",
  "entry_device_deletion_flag",
  "downtime_pack",
  "evidence_pack_item",
  "letter",
  "feed_item",
  "feed_item_withdrawal",
  "feed_view",
  "tenant_setting_decision",
  "retention_decision",
  "dcb0160_record",
  "sub_processor_notice",
  "sub_processor_response",
  "policy_signature",
  "processor_breach_notice",
  "processor_breach_notice_ack",
  "dspt_evidence",
];
/** Audit and history rows may be written before a tenant is chosen. */
const NULLABLE_TENANT_TABLES = ["audit_event", "record_version"];
const GLOBAL_REFERENCE_TABLES = ["form_template", "rate_table", "retention_class"];

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

async function publicTables(): Promise<string[]> {
  const { rows } = await db
    .pool("harbour_owner")
    .query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
  return rows.map((r) => r.tablename);
}

describe("hazard HZ-011 row-level security coverage", () => {
  it("has tables to check", async () => {
    expect((await publicTables()).length).toBeGreaterThan(20);
  });

  it("enables and forces RLS on every public table", async () => {
    const { rows } = await db.pool("harbour_owner").query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const failing = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity);
    expect(failing.map((r) => r.relname)).toEqual([]);
  });

  it("gives every table with a tenant_id column a policy keyed on the current tenant", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ table_name: string }>(
      `SELECT c.table_name
       FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
         AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = c.table_name
             AND (p.qual LIKE '%current_tenant_id()%' OR p.with_check LIKE '%current_tenant_id()%')
         )`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it("never lets the application role delete, and keeps append-only tables append-only", async () => {
    const { rows } = await db.pool("harbour_owner").query<{
      table_name: string;
      privilege_type: string;
    }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'harbour_app' AND table_schema = 'public'
         AND (privilege_type IN ('DELETE', 'TRUNCATE')
              OR (privilege_type = 'UPDATE' AND table_name = ANY($1)))`,
      [APPEND_ONLY_TABLES],
    );
    expect(rows).toEqual([]);
  });

  it("protects append-only tables with triggers as well as grants", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ tgname: string; relname: string }>(
      `SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND t.tgname IN ('append_only', 'append_only_truncate')`,
    );
    for (const table of APPEND_ONLY_TABLES) {
      expect(
        rows
          .filter((r) => r.relname === table)
          .map((r) => r.tgname)
          .sort(),
      ).toEqual(["append_only", "append_only_truncate"]);
    }
  });

  it("only lets global reference tables hold rows without a tenant", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id' AND is_nullable = 'YES'
       ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(
      [...GLOBAL_REFERENCE_TABLES, ...NULLABLE_TENANT_TABLES].sort(),
    );
  });

  it("gives no Harbour role the ability to bypass RLS", async () => {
    const { rows } = await db
      .pool("harbour_owner")
      .query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname = ANY($1) AND (rolbypassrls OR rolsuper)",
        [[...LOGIN_ROLES, ...NOLOGIN_ROLES]],
      );
    expect(rows).toEqual([]);
  });

  it("keeps the auth schema out of reach of the application role", async () => {
    const { rows } = await db
      .pool("harbour_owner")
      .query<{ has: boolean }>(
        "SELECT has_schema_privilege('harbour_app', 'auth', 'USAGE') AS has",
      );
    expect(rows[0]?.has).toBe(false);
  });

  it("versions every mutable aggregate with tenant data", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'version'
         AND c.table_name NOT IN ('tenant_group', 'operator_user')
         AND NOT EXISTS (
           SELECT 1 FROM pg_trigger t JOIN pg_class k ON k.oid = t.tgrelid
           WHERE k.relname = c.table_name AND t.tgname = 'capture_version'
         )`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
