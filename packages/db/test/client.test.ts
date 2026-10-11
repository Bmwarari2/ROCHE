import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type IdleConnectionError } from "../src/client";
import { createTestDatabase, type TestDatabase, withAdminClient } from "./support/database";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

describe("createPool", () => {
  it("survives an idle connection being ended, reports it, and opens a new one", async () => {
    const errors: IdleConnectionError[] = [];
    let reported: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const pool = createPool(db.url("harbour_app"), { max: 1 }, (error) => {
      errors.push(error);
      reported();
    });
    try {
      const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0]?.pid;
      // An administrator (or a failover) ends the session while it waits in the pool.
      await withAdminClient((admin) => admin.query("SELECT pg_terminate_backend($1)", [pid]));
      await seen;
      expect(errors.map((e) => e.code)).toEqual(["57P01"]);

      const after = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(after.rows[0]?.pid).not.toBe(pid);
    } finally {
      await pool.end();
    }
  });
});
