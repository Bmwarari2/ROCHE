import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Permission-aware search through the API (PLAT-013; platform-completions.md rules 1 to 8;
 * ADR-0070, ADR-0071; hazards HZ-001 and HZ-011): each kind of record in its own permission's
 * scope under forced RLS, never another tenant's, never widened by break-glass; people who have
 * left only for those who may ask for them; NHS numbers exact; agency workers with no shift
 * refused; every search audited with the ids shown and never the words typed.
 */

let h: Harness;
const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const ADA = resident(1);
const DEV = resident(4);

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

interface Results {
  items: {
    type: string;
    id: string;
    match: string;
    sameName: boolean;
    person: { name: string; dateOfBirth: string | null; nhsNumber: string | null } | null;
    note: { excerpt: string } | null;
    staff: { name: string } | null;
  }[];
  counts: Record<string, number>;
  total: number;
  omitted: { type: string; reason: string }[];
  personScope: string | null;
}

const search = (who: string, body: object, tenant: string = DEMO.tenantId) =>
  h.request("/v1/search", { method: "POST", body, token: h.tokens[who], tenant });
const results = async (who: string, body: object) => {
  const response = await search(who, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Results;
};
const ids = (r: Results, type = "person") =>
  r.items.filter((i) => i.type === type).map((i) => i.id);
const lastAudit = async (action: string) =>
  (
    await sql<{ scope: Record<string, unknown>; reason: string | null }>(
      "SELECT scope, reason FROM audit_event WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1",
      [action],
    )
  )[0];

beforeAll(async () => {
  h = await createHarness();
  const [loc] = await sql<{ id: string }>("SELECT location_id AS id FROM person WHERE id = $1", [
    ADA,
  ]);
  // A note and its correction: only the correction is found.
  const [first] = await sql<{ id: string }>(
    `INSERT INTO care_note (person_id, location_id, occurred_at, category, body)
     VALUES ($1, $2, now() - interval '2 hours', 'activity', 'Played dominoes in the conservatory')
     RETURNING id`,
    [ADA, loc?.id],
  );
  await sql(
    `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, supersedes_id,
       correction_reason)
     VALUES ($1, $2, now() - interval '2 hours', 'activity', 'Played draughts in the conservatory',
       $3, 'Wrong game')`,
    [ADA, loc?.id, first?.id],
  );
  // Elsie (5) has left the service.
  await sql("UPDATE person SET status = 'discharged', discharged_at = now() WHERE id = $1", [
    resident(5),
  ]);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-011 search follows permission and scope through the API", () => {
  it("finds a person by name and preferred name, in scope, with identity fields, and audits ids only", async () => {
    const r = await results("manager", { query: "Addie" });
    expect(ids(r)).toEqual([ADA]);
    const [ada] = r.items;
    expect(ada?.person).toMatchObject({ name: "Ada Example", dateOfBirth: "1938-02-01" });
    expect(ada?.match).toBe("exact");
    const event = await lastAudit("platform.search.run");
    expect(event?.scope).toMatchObject({ personIds: [ADA], careRecordView: true, termCount: 1 });
    // Never the words typed, not even inside the scope.
    expect(JSON.stringify(event)).not.toMatch(/addie/i);
  });

  it("finds by an exact NHS number and refuses a mistyped one, audited without the number", async () => {
    expect(ids(await results("manager", { query: "999 000 0018" }))).toEqual([ADA]);
    const refused = await search("manager", { query: "999 000 0019" });
    expect(refused.status).toBe(422);
    const event = await lastAudit("platform.search.refused");
    expect(event?.scope).toMatchObject({ problem: "invalid_nhs_number", queryKind: null });
    expect(JSON.stringify(event)).not.toContain("0019");
  });

  it("an out-of-scope match looks exactly like no match", async () => {
    // Gwen lives at Harbour Lodge, outside the Registered Manager's location.
    const outside = await results("manager", { query: "Gwen Outofscope" });
    const nothing = await results("manager", { query: "Nobody Atall" });
    expect(outside.items).toEqual([]);
    expect({ ...outside, items: [] }).toEqual({ ...nothing, items: [] });
    // The owner, across the organisation, finds her.
    expect(ids(await results("owner", { query: "Gwen" }))).toEqual([LODGE.personId]);
  });

  it("a care worker finds only the people assigned to them", async () => {
    const carer = await results("carer", { query: "Example Fixture", types: ["person"] });
    expect(ids(carer)).toEqual([]);
    expect(ids(await results("carer", { query: "Ada" }))).toEqual([ADA]);
    expect(ids(await results("carer", { query: "Dev" }))).toEqual([]);
    expect(ids(await results("manager", { query: "Dev" }))).toEqual([DEV]);
    expect((await lastAudit("platform.search.run"))?.scope).toMatchObject({
      personScope: "locations",
    });
  });

  it("never finds another organisation's records, even with the same name", async () => {
    expect(ids(await results("manager", { query: "Hal Elsewhere" }))).toEqual([]);
    const other = await search("rae", { query: "Ada Example" }, OTHER.tenantId);
    // The other provider's manager has no search permission there, or finds nothing of ours.
    if (other.status === 200) expect(((await other.json()) as Results).items).toEqual([]);
    else expect(other.status).toBe(403);
  });

  it("break-glass access never widens ordinary search", async () => {
    await sql(
      `INSERT INTO break_glass_event (tenant_user_id, person_id, justification, expires_at,
         reason_code)
       VALUES ($1, $2, 'Covering the lodge tonight while the nurse is off sick',
         now() + interval '1 hour', 'covering_another_area')`,
      [DEMO.users.manager.id, LODGE.personId],
    );
    expect(ids(await results("manager", { query: "Gwen" }))).toEqual([]);
  });

  it("leaves out people who have left unless the user may and does ask", async () => {
    expect(ids(await results("owner", { query: "Elsie" }))).toEqual([]);
    expect(ids(await results("owner", { query: "Elsie", includeArchived: true }))).toEqual([
      resident(5),
    ]);
    const carer = await search("carer", { query: "Elsie", includeArchived: true });
    expect(carer.status).toBe(403);
    expect(((await carer.json()) as { code: string }).code).toBe("archived_not_permitted");
  });

  it("finds notes by their words, showing the correction and never the note it replaced", async () => {
    const r = await results("manager", { query: "conservatory", types: ["note"] });
    expect(r.items.map((i) => i.note?.excerpt)).toEqual(["Played draughts in the conservatory"]);
    expect(ids(await results("manager", { query: "dominoes", types: ["note"] }), "note")).toEqual(
      [],
    );
  });

  it("finds colleagues by name for those who manage staff, never a carer", async () => {
    const r = await results("manager", { query: "Cat", types: ["staff"] });
    expect(r.items.map((i) => i.staff?.name)).toEqual(["Cat Carer"]);
    const carer = await search("carer", { query: "Cat", types: ["staff"] });
    expect(carer.status).toBe(403);
    expect(((await carer.json()) as { code: string }).code).toBe("nothing_to_search");
  });

  it("refuses an agency worker with no booked shift (ADR-0088: their roles reach nothing)", async () => {
    await sql("UPDATE tenant_user SET is_agency = true WHERE id = $1", [DEMO.users.carer.id]);
    try {
      const refused = await search("carer", { query: "Ada" });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("missing_permission");
    } finally {
      await sql("UPDATE tenant_user SET is_agency = false WHERE id = $1", [DEMO.users.carer.id]);
    }
  });

  it("refuses a query over 200 characters before any other work", async () => {
    expect((await search("manager", { query: "x".repeat(201) })).status).toBe(422);
    expect((await search("manager", { query: "a" })).status).toBe(422);
  });
});

describe("hazard HZ-011 the queries and the plan agree, so routine searches raise no alarm", () => {
  const alarms = async () =>
    (await sql("SELECT id FROM audit_event WHERE action = 'platform.search.dropped_by_plan'"))
      .length;

  it("a search that meets a corrected note, or a colleague at another home, drops nothing", async () => {
    // A colleague who works only at Harbour Lodge, outside the Registered Manager's location.
    const [lodgeWorker] = await sql<{ id: string }>(
      `INSERT INTO tenant_user (display_name, email, status)
       VALUES ('Lola Lodgeworker', 'lola@example.invalid', 'active') RETURNING id`,
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT $1, id, $2 FROM role WHERE key = 'care_worker'`,
      [lodgeWorker?.id, LODGE.locationId],
    );
    const before = await alarms();
    await results("manager", { query: "conservatory" });
    const staff = await results("manager", { query: "Lola", types: ["staff"] });
    expect(staff.items).toEqual([]);
    // The owner, across the organisation, finds her.
    expect(
      (await results("owner", { query: "Lola", types: ["staff"] })).items.map((i) => i.id),
    ).toEqual([lodgeWorker?.id]);
    expect(await alarms()).toBe(before);
  });

  it("never finds the notes or documents of a person deleted from the record", async () => {
    const [loc] = await sql<{ id: string }>("SELECT location_id AS id FROM person WHERE id = $1", [
      resident(6),
    ]);
    await sql(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body)
       VALUES ($1, $2, now() - interval '1 hour', 'activity', 'Watched the snooker final')`,
      [resident(6), loc?.id],
    );
    expect(
      ids(await results("manager", { query: "snooker", types: ["note"] }), "note"),
    ).toHaveLength(1);
    await sql("UPDATE person SET deleted_at = now() WHERE id = $1", [resident(6)]);
    try {
      expect(ids(await results("manager", { query: "snooker", types: ["note"] }), "note")).toEqual(
        [],
      );
    } finally {
      await sql("UPDATE person SET deleted_at = NULL WHERE id = $1", [resident(6)]);
    }
  });

  it("limits each member's searches a minute, from the rate table", async () => {
    const [rate] = await sql<{ value: string }>(
      "SELECT value FROM rate_table WHERE key = 'search.requests_per_minute' AND tenant_id IS NULL",
    );
    const limit = Number(rate?.value);
    expect(limit).toBeGreaterThan(0);
    const statuses: number[] = [];
    for (let n = 0; n <= limit; n += 1) {
      statuses.push((await search("nurse", { query: "Ada" })).status);
    }
    expect(statuses.slice(0, limit).every((s) => s === 200)).toBe(true);
    expect(statuses[limit]).toBe(429);
  });
});
