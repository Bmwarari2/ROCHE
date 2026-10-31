import { describe, expect, it } from "vitest";
import { ensurePgaudit, type PgauditState, pgauditReady } from "../src/admin/extensions";
import { createTestDatabase, withAdminClient } from "./support/database";

/** pgAudit in db:bootstrap (section 5.5): created where offered, skipped cleanly where not. */

function fakeClient(installed: string | null | undefined, create: () => void = () => {}) {
  const statements: string[] = [];
  return {
    statements,
    async query(sql: string) {
      statements.push(sql);
      if (sql.startsWith("SELECT")) {
        return { rows: installed === undefined ? [] : [{ installed_version: installed }] };
      }
      create();
      return { rows: [] };
    },
  };
}

describe("ensurePgaudit", () => {
  it.each([
    ["not offered", undefined, "unavailable", false],
    ["already installed", "17.0", "present", false],
    ["offered and created", null, "created", true],
  ] as const)("%s: %s", async (_case, installed, state, creates) => {
    const client = fakeClient(installed);
    // why: the fake implements only the query method ensurePgaudit uses.
    expect(await ensurePgaudit(client as never)).toBe(state);
    expect(client.statements.some((s) => s.startsWith("CREATE EXTENSION"))).toBe(creates);
  });

  it("reports an extension the server does not preload, without failing", async () => {
    const client = fakeClient(null, () => {
      throw new Error('pgaudit must be loaded via "shared_preload_libraries"');
    });
    expect(await ensurePgaudit(client as never)).toBe("not_loaded");
  });

  it("passes on any other error", async () => {
    const client = fakeClient(null, () => {
      throw new Error("permission denied to create extension");
    });
    await expect(ensurePgaudit(client as never)).rejects.toThrow(/permission denied/);
  });

  it.each([
    ["created", true],
    ["present", true],
    ["unavailable", false],
    ["not_loaded", false],
  ] as const)("%s is ready for production: %s", (state: PgauditState, ready) => {
    expect(pgauditReady(state)).toBe(ready);
  });

  it("is idempotent against a real database, skipping cleanly where pgaudit is not offered", async () => {
    const db = await createTestDatabase();
    try {
      const first = await withAdminClient((client) => ensurePgaudit(client), db.name);
      const second = await withAdminClient((client) => ensurePgaudit(client), db.name);
      expect(["created", "present", "unavailable", "not_loaded"]).toContain(first);
      if (first === "created" || first === "present") expect(second).toBe("present");
      else expect(second).toBe(first);
    } finally {
      await db.drop();
    }
  });
});
