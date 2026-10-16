import { DEMO } from "@harbour/db/seed";
import { SAMPLE_PEOPLE } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Sample data mode through the API (PLAT-018; platform-completions.md rules 29 to 32; HZ-072):
 * loaded only by a holder of platform.onboarding.manage before any real person exists, once;
 * real people wait until it has gone; removed in one step; kept out of the full export; audited,
 * refusals too.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (who: string) => ({ token: h.tokens[who], tenant: DEMO.tenantId });
const send = (method: string, who: string) =>
  h.request("/v1/onboarding/sample-data", { method, ...as(who) });

/** Runs SQL as the owner role across the demo organisation, committed. */
async function ownerSql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const audits = (action: string) =>
  ownerSql<{ outcome: string; reason: string | null; scope: unknown }>(
    "SELECT outcome, reason, scope FROM audit_event WHERE action = $1 ORDER BY seq",
    [action],
  );

const LOADED = "platform.onboarding.sample_loaded";
const REMOVED = "platform.onboarding.sample_removed";

describe("hazard HZ-072 sample data mode (rules 29 to 32)", () => {
  it("refuses a member without platform.onboarding.manage", async () => {
    expect((await send("POST", "carer")).status).toBe(403);
    expect((await send("DELETE", "carer")).status).toBe(403);
  });

  it("refuses to load while real people exist, audited", async () => {
    const res = await send("POST", "owner");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "real_people_exist" });
    expect(await audits(LOADED)).toEqual([
      expect.objectContaining({ outcome: "denied", reason: "real_people_exist" }),
    ]);
  });

  it("loads once before any real person, keeps real people out, and removes it in one step", async () => {
    // The demo organisation's people leave, so it has none.
    await ownerSql("UPDATE person SET deleted_at = now() WHERE deleted_at IS NULL");
    expect((await send("DELETE", "owner")).status).toBe(409);

    const loaded = await send("POST", "owner");
    expect(loaded.status).toBe(200);
    const batch = (await loaded.json()) as { batchId: string; people: number };
    expect(batch.people).toBe(SAMPLE_PEOPLE.length);
    const people = await ownerSql<{ family_name: string; nhs_number: string }>(
      "SELECT family_name, nhs_number FROM person WHERE sample_batch_id = $1 ORDER BY nhs_number",
      [batch.batchId],
    );
    expect(people).toHaveLength(SAMPLE_PEOPLE.length);
    expect(people.every((p) => p.family_name === "Example" && p.nhs_number.startsWith("999"))).toBe(
      true,
    );

    const again = await send("POST", "owner");
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "already_loaded" });

    const checklist = (await (await h.request("/v1/onboarding", as("owner"))).json()) as {
      items: { key: string; done: boolean }[];
    };
    expect(checklist.items.find((i) => i.key === "sample_data_removed")?.done).toBe(false);

    // A real person waits, by any path that writes one.
    await expect(
      ownerSql(
        `INSERT INTO person (location_id, status, nhs_number, given_name, family_name,
                             date_of_birth, allergy_status)
         SELECT id, 'active', '9990000999', 'Rae', 'Example', '1945-05-05', 'unknown'
           FROM location LIMIT 1`,
      ),
    ).rejects.toThrow(/remove_sample_data_first/);

    const removed = await send("DELETE", "owner");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ batchId: batch.batchId, people: SAMPLE_PEOPLE.length });
    expect(
      await ownerSql("SELECT id FROM person WHERE sample_batch_id = $1", [batch.batchId]),
    ).toEqual([]);
    expect(await audits(REMOVED)).toEqual([
      expect.objectContaining({ outcome: "denied", reason: "nothing_to_remove" }),
      expect.objectContaining({ outcome: "success", scope: { people: SAMPLE_PEOPLE.length } }),
    ]);
    expect(await audits(LOADED)).toEqual([
      expect.objectContaining({ outcome: "denied", reason: "real_people_exist" }),
      expect.objectContaining({ outcome: "success", scope: { people: SAMPLE_PEOPLE.length } }),
      expect.objectContaining({ outcome: "denied", reason: "already_loaded" }),
    ]);
    const nothing = await send("DELETE", "owner");
    expect(nothing.status).toBe(409);
    expect(await nothing.json()).toMatchObject({ code: "nothing_to_remove" });
  });
});
