import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

describe("migrations", () => {
  it("apply cleanly to an empty database", async () => {
    const { rows } = await db
      .pool("harbour_owner")
      .query<{ count: string }>("SELECT count(*) FROM drizzle.__drizzle_migrations");
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(3);
  });

  it("generate UUIDv7 identifiers", async () => {
    const { rows } = await db
      .pool("harbour_owner")
      .query<{ id: string }>("SELECT app.uuid_v7()::text AS id");
    expect(rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
