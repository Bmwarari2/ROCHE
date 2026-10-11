import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO, seedDemoTenant, seedReferenceData } from "../src/seed/demo";
import { parseBankHolidays, parseRates, parseRetention } from "../src/seed/reference-data";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, inContext } from "./support/fixtures";

const specs = fileURLToPath(new URL("../../../docs/specs/", import.meta.url));

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

describe("seed", () => {
  it("loads the reference documents and the demo tenant, idempotently", async () => {
    const rates = parseRates(readFileSync(`${specs}rates.md`, "utf8"));
    const retention = parseRetention(readFileSync(`${specs}retention.md`, "utf8"));
    const holidays = parseBankHolidays(readFileSync(`${specs}calendar.md`, "utf8"));
    await seedReferenceData(db.pool("harbour_owner"), rates, retention, holidays);
    await seedReferenceData(db.pool("harbour_owner"), rates, retention, holidays);
    expect(await seedDemoTenant(db.pool("harbour_owner"))).toEqual({ created: true });
    expect(await seedDemoTenant(db.pool("harbour_owner"))).toEqual({ created: false });

    const counts = await inContext(
      db.pool("harbour_app"),
      ctx(DEMO.tenantId, DEMO.users.manager.id, "locations", [DEMO.locationId]),
      async (c) => {
        const people = await c.query("SELECT 1 FROM person");
        const rooms = await c.query("SELECT 1 FROM room");
        const roles = await c.query("SELECT 1 FROM role");
        const globalRates = await c.query("SELECT 1 FROM rate_table WHERE tenant_id IS NULL");
        const bankHolidays = await c.query("SELECT 1 FROM bank_holiday");
        return {
          people: people.rowCount,
          rooms: rooms.rowCount,
          roles: roles.rowCount,
          rates: globalRates.rowCount,
          bankHolidays: bankHolidays.rowCount,
        };
      },
    );
    expect(counts).toEqual({
      people: 6,
      rooms: 60,
      roles: 21,
      rates: rates.length,
      bankHolidays: holidays.length,
    });
  });

  it("switches on the tools awaiting licence confirmation for the demo tenant only (H-25)", async () => {
    const flags = await inContext(
      db.pool("harbour_app"),
      ctx(DEMO.tenantId, DEMO.users.manager.id, "locations", [DEMO.locationId]),
      async (c) => {
        const { rows } = await c.query<{ flag_key: string; enabled: boolean }>(
          "SELECT flag_key, enabled FROM feature_flag WHERE flag_key LIKE 'care.tool.%' ORDER BY flag_key",
        );
        return rows;
      },
    );
    expect(flags).toEqual([
      { flag_key: "care.tool.braden", enabled: true },
      { flag_key: "care.tool.waterlow", enabled: true },
    ]);
  });

  it("keeps bank holidays read-only for the application", async () => {
    await expect(
      inContext(db.pool("harbour_app"), ctx(DEMO.tenantId, null, "tenant"), (c) =>
        c.query(
          "INSERT INTO bank_holiday (nation, date, name) VALUES ('england', '2030-01-01', 'x')",
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("uses only test-range NHS numbers and example.invalid addresses", async () => {
    const rows = await inContext(
      db.pool("harbour_app"),
      ctx(DEMO.tenantId, null, "tenant"),
      async (c) => {
        const people = await c.query<{ nhs_number: string }>("SELECT nhs_number FROM person");
        const emails = await c.query<{ email: string }>(
          "SELECT email FROM tenant_user UNION ALL SELECT email FROM contact WHERE email IS NOT NULL",
        );
        return {
          nhs: people.rows.map((r) => r.nhs_number),
          emails: emails.rows.map((r) => r.email),
        };
      },
    );
    expect(rows.nhs.every((n) => n.startsWith("999"))).toBe(true);
    expect(rows.emails.every((e) => e.endsWith("@example.invalid"))).toBe(true);
  });

  it("gives the demo care worker their three assigned residents only", async () => {
    const names = await inContext(
      db.pool("harbour_app"),
      ctx(DEMO.tenantId, DEMO.users.carer.id, "assigned"),
      async (c) => {
        const { rows } = await c.query<{ given_name: string }>(
          "SELECT given_name FROM person ORDER BY given_name",
        );
        return rows.map((r) => r.given_name);
      },
    );
    expect(names).toEqual(["Ada", "Ben", "Cara"]);
  });
});
