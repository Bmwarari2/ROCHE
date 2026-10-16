import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Break-glass search through the API (platform-completions.md rule 9; master prompt section 4;
 * hazards HZ-001 and HZ-011): step-up, a reason code and a typed reason, a specific whole-word
 * query; people only, identity only, across the organisation and never another; a record that
 * opens nothing, so ordinary search and the person's record stay closed; the Registered Manager
 * and the data protection lead alerted; a daily limit that tells the data protection lead; audited
 * with ids only, the reason kept in the break-glass record.
 */

let h: Harness;
const REASON = "Ambulance crew asking about a resident at the lodge";

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const post = (who: string, path: string, body: object) =>
  h.request(path, { method: "POST", body, token: h.tokens[who], tenant: DEMO.tenantId });
const breakGlass = (who: string, query: string, extra: object = {}) =>
  post(who, "/v1/search/break-glass", {
    query,
    reasonCode: "request_from_professional",
    reason: REASON,
    ...extra,
  });
const code = async (r: Response) => ((await r.json()) as { code: string }).code;

interface Found {
  items: { id: string; name: string; dateOfBirth: string | null; nhsNumber: string | null }[];
  total: number;
  more: boolean;
  breakGlassId: string;
}

/** The unrouted alert audited for one search record, if any. */
const unrouted = async (resourceId: string) =>
  (
    await sql<{ reason: string }>(
      `SELECT reason FROM audit_event WHERE action = 'platform.search.break_glass_alert_unrouted'
       AND resource_id = $1`,
      [resourceId],
    )
  ).map((r) => r.reason);

const setLeadStatus = (status: string) =>
  sql("UPDATE tenant_user SET status = $1 WHERE id = $2", [status, DEMO.users.nurse.id]);

beforeAll(async () => {
  h = await createHarness();
  // The nurse is the organisation's data protection lead.
  await sql("UPDATE tenant SET data_protection_lead_id = $1 WHERE id = $2", [
    DEMO.users.nurse.id,
    DEMO.tenantId,
  ]);
}, 120_000);

beforeEach(async () => {
  // A second factor used just now: step-up is fresh.
  for (const who of ["manager", "owner"]) {
    await ageSession(h.db.pool("harbour_auth"), h.tokens[who]?.split(".")[0] ?? "", 0);
  }
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-011 break-glass search", () => {
  it("finds a person outside scope by full name, identity only, alerts and audits ids only, and opens nothing", async () => {
    const response = await breakGlass("manager", "Gwen Outofscope");
    expect(response.status, await response.clone().text()).toBe(200);
    const found = (await response.json()) as Found;
    expect(found.items.map((i) => i.id)).toEqual([LODGE.personId]);
    expect(found.items[0]).toMatchObject({ name: "Gwen Outofscope", nhsNumber: "9990000077" });
    expect(found.items[0]).not.toHaveProperty("locationName");

    // The reason is kept once, in a search record that opens nothing.
    const [record] = await sql<{ kind: string; person_id: string | null; justification: string }>(
      "SELECT kind, person_id, justification FROM break_glass_event WHERE id = $1",
      [found.breakGlassId],
    );
    expect(record).toEqual({ kind: "search", person_id: null, justification: REASON });

    // Audited with ids and a reference to the record, never the words or the reason.
    const [event] = await sql<{ scope: Record<string, unknown>; reason: string | null }>(
      "SELECT scope, reason FROM audit_event WHERE action = 'platform.search.break_glass' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(event?.scope).toMatchObject({
      breakGlassRecordId: found.breakGlassId,
      personIds: [LODGE.personId],
      reasonCode: "request_from_professional",
    });
    expect(JSON.stringify(event)).not.toMatch(/Outofscope|Ambulance/);

    // The data protection lead is alerted, in generic words.
    const [alert] = await sql<{ title: string; recipient: string }>(
      `SELECT title, recipient_tenant_user_id AS recipient FROM notification
       WHERE source_id = $1 AND kind = 'platform.search.break_glass'`,
      [found.breakGlassId],
    );
    expect(alert).toEqual({
      title: "A break-glass search was made",
      recipient: DEMO.users.nurse.id,
    });
    // The lodge has no Registered Manager: the alert that could not go there is audited.
    expect(await unrouted(found.breakGlassId)).toEqual(["no_registered_manager"]);

    // The record keeps the home shown, for the weekly report.
    const [shown] = await sql<{ shown_location_ids: string[] }>(
      "SELECT shown_location_ids FROM break_glass_event WHERE id = $1",
      [found.breakGlassId],
    );
    expect(shown?.shown_location_ids).toEqual([LODGE.locationId]);

    // Nothing widened: ordinary search and the record itself stay closed to the manager.
    const ordinary = await post("manager", "/v1/search", { query: "Gwen Outofscope" });
    expect(((await ordinary.json()) as { items: unknown[] }).items).toEqual([]);
    const record404 = await h.request(`/v1/people/${LODGE.personId}`, {
      token: h.tokens.manager,
      tenant: DEMO.tenantId,
    });
    expect(record404.status).toBe(404);
  });

  it("finds by exact NHS number, never by a prefix or one word", async () => {
    const byNhs = (await (await breakGlass("manager", "999 000 0077")).json()) as Found;
    expect(byNhs.items.map((i) => i.id)).toEqual([LODGE.personId]);
    const prefix = (await (await breakGlass("manager", "Gwe Outofsc")).json()) as Found;
    expect(prefix.items).toEqual([]);
    const oneWord = await breakGlass("manager", "Gwen");
    expect(oneWord.status).toBe(422);
  });

  it("never finds another organisation's people", async () => {
    const found = (await (await breakGlass("manager", "Hal Elsewhere")).json()) as Found;
    expect(found.items).toEqual([]);
    expect(found.total).toBe(0);
  });

  it("needs the permission, a reason long enough and a fresh second factor", async () => {
    const carer = await breakGlass("carer", "Gwen Outofscope");
    expect(carer.status).toBe(403);
    expect(await code(carer)).toBe("missing_permission");
    const short = await breakGlass("manager", "Gwen Outofscope", { reason: "need it now" });
    expect(short.status).toBe(422);
    await ageSession(h.db.pool("harbour_auth"), h.tokens.manager?.split(".")[0] ?? "", 3600);
    const stale = await breakGlass("manager", "Gwen Outofscope");
    expect(stale.status).toBe(403);
    expect(await code(stale)).toBe("step_up_required");
  });

  it("alerts the Registered Manager of each home whose people were shown, and the data protection lead", async () => {
    const found = (await (await breakGlass("owner", "Ada Example")).json()) as Found;
    expect(found.items.map((i) => i.name)).toEqual(["Ada Example"]);
    const told = await sql<{ recipient: string }>(
      `SELECT recipient_tenant_user_id AS recipient FROM notification
       WHERE source_id = $1 ORDER BY recipient_tenant_user_id`,
      [found.breakGlassId],
    );
    expect(told.map((t) => t.recipient).sort()).toEqual(
      [DEMO.users.manager.id, DEMO.users.nurse.id].sort(),
    );
    expect(await unrouted(found.breakGlassId)).toEqual([]);
  });

  it("never tells a suspended data protection lead, and audits the alert as unrouted", async () => {
    await setLeadStatus("suspended");
    try {
      const found = (await (await breakGlass("manager", "Gwen Outofscope")).json()) as Found;
      const told = await sql("SELECT 1 FROM notification WHERE source_id = $1", [
        found.breakGlassId,
      ]);
      expect(told).toEqual([]);
      expect(await unrouted(found.breakGlassId)).toEqual([
        "no_registered_manager,no_data_protection_lead",
      ]);
    } finally {
      await setLeadStatus("active");
    }
  });

  it("hazard HZ-001: never says more were found than are shown, and asks for a narrower search", async () => {
    await sql(
      `INSERT INTO person (location_id, status, given_name, family_name)
       SELECT $1, 'active', 'Bea', 'Manyfold' FROM generate_series(1, 11)`,
      [LODGE.locationId],
    );
    const found = (await (await breakGlass("owner", "Bea Manyfold")).json()) as Found;
    expect(found.items).toHaveLength(10);
    expect(found).toMatchObject({ total: 10, more: true });
    const one = (await (await breakGlass("owner", "Gwen Outofscope")).json()) as Found;
    expect(one).toMatchObject({ total: 1, more: false });
  });

  it("refuses at the daily limit from the rate table and tells the data protection lead", async () => {
    const [rate] = await sql<{ value: string }>(
      "SELECT value FROM rate_table WHERE key = 'break_glass.search_max_per_day' AND tenant_id IS NULL",
    );
    const [used] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM break_glass_event WHERE kind = 'search'
       AND tenant_user_id = $1 AND opened_at > now() - interval '24 hours'`,
      [DEMO.users.owner.id],
    );
    // What is left of the owner's searches today (one was made above).
    const limit = Number(rate?.value) - Number(used?.n ?? 0);
    expect(limit).toBeGreaterThan(0);
    // All at once: the lock on the user lets exactly the searches left through.
    const statuses = await Promise.all(
      Array.from(
        { length: limit + 2 },
        async () => (await breakGlass("owner", "Gwen Outofscope")).status,
      ),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(limit);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    const told = await sql<{ title: string }>(
      `SELECT title FROM notification WHERE kind = 'platform.search.break_glass_limit'
       AND recipient_tenant_user_id = $1`,
      [DEMO.users.nurse.id],
    );
    expect(told.map((t) => t.title)).toEqual(["Break-glass search limit reached"]);
    const [refused] = await sql<{ scope: Record<string, unknown> }>(
      "SELECT scope FROM audit_event WHERE action = 'platform.search.refused' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(refused?.scope).toMatchObject({ problem: "rate_limited", breakGlass: true });

    // With no active data protection lead, the refusal is still made and the alert audited.
    await setLeadStatus("suspended");
    try {
      expect((await breakGlass("owner", "Gwen Outofscope")).status).toBe(429);
      expect(await unrouted(DEMO.users.owner.id)).toEqual(["no_data_protection_lead"]);
    } finally {
      await setLeadStatus("active");
    }
  });
});
