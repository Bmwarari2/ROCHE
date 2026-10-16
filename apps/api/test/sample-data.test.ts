import { DEMO } from "@harbour/db/seed";
import { SAMPLE_PEOPLE } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness } from "./support/harness";

/**
 * Sample data mode through the API (PLAT-018; platform-completions.md rules 29 to 32; HZ-072):
 * loaded only by a holder of platform.onboarding.manage, once, into an organisation that has never
 * had a real person; real people wait until it has gone; removed in one step with a fresh step-up,
 * with everything recorded about the sample people while practising; audited, refusals too.
 */

let h: Harness;

/** A new organisation the demo owner also belongs to, with no people yet. */
const NEW = {
  tenantId: "0194f000-0000-7000-8000-000000000001",
  locationId: "0194f000-0000-7000-8000-000000000101",
  ownerId: "0194f000-0000-7000-8000-000000000301",
  roleId: "0194f000-0000-7000-8000-000000000401",
};

/** Runs SQL as the owner role across one organisation, committed. */
async function ownerSql<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
  tenant = NEW.tenantId,
) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true),
              set_config('app.user_id', $2, true)`,
      [tenant, NEW.ownerId],
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

beforeAll(async () => {
  h = await createHarness();
  await ownerSql(
    `INSERT INTO tenant (id, name, legal_name, legal_form, status)
     VALUES ($1, 'New Provider', 'New Provider Ltd', 'limited_company', 'onboarding')`,
    [NEW.tenantId],
  );
  await ownerSql("INSERT INTO location (id, name) VALUES ($1, 'Hill House')", [NEW.locationId]);
  await ownerSql(
    `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
     VALUES ($1, $2, 'Owen Owner', 'owen.owner@example.invalid', 'active')`,
    [NEW.ownerId, h.authIds.owner],
  );
  await ownerSql(
    `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
       ($1, 'onboarder', 'Onboarder', 'tenant',
        '{platform.onboarding.manage,platform.onboarding.read,people.person.read,care.note.create,care.note.read}')`,
    [NEW.roleId],
  );
  await ownerSql("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
    NEW.ownerId,
    NEW.roleId,
  ]);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (who: string, tenant = NEW.tenantId) => ({ token: h.tokens[who], tenant });
const send = (method: string, who = "owner", tenant = NEW.tenantId) =>
  h.request("/v1/onboarding/sample-data", { method, ...as(who, tenant) });
const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

const audits = (action: string) =>
  ownerSql<{ outcome: string; reason: string | null; scope: unknown }>(
    "SELECT outcome, reason, scope FROM audit_event WHERE action = $1 ORDER BY seq",
    [action],
  );

const LOADED = "platform.onboarding.sample_loaded";
const REMOVED = "platform.onboarding.sample_removed";

describe("hazard HZ-072 sample data mode (rules 29 to 32)", () => {
  it("refuses a member without platform.onboarding.manage", async () => {
    expect((await send("POST", "carer", DEMO.tenantId)).status).toBe(403);
    expect((await send("DELETE", "carer", DEMO.tenantId)).status).toBe(403);
  });

  it("refuses to load where real people exist, audited", async () => {
    const res = await send("POST", "owner", DEMO.tenantId);
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("real_people_exist");
    const refusals = await ownerSql(
      "SELECT outcome, reason FROM audit_event WHERE action = $1",
      [LOADED],
      DEMO.tenantId,
    );
    expect(refusals).toEqual([{ outcome: "denied", reason: "real_people_exist" }]);
  });

  it("loads once, keeps real people out, and removes the batch with what was practised on it", async () => {
    expect(await codeOf(await send("DELETE"))).toBe("nothing_to_remove");

    const loaded = await send("POST");
    expect(loaded.status).toBe(200);
    const batch = (await loaded.json()) as { batchId: string; people: number };
    expect(batch.people).toBe(SAMPLE_PEOPLE.length);
    const people = await ownerSql<{ id: string; family_name: string; nhs_number: string }>(
      "SELECT id, family_name, nhs_number FROM person WHERE sample_batch_id = $1 ORDER BY nhs_number",
      [batch.batchId],
    );
    expect(people).toHaveLength(SAMPLE_PEOPLE.length);
    expect(people.every((p) => p.family_name === "Example" && p.nhs_number.startsWith("999"))).toBe(
      true,
    );
    expect(await codeOf(await send("POST"))).toBe("already_loaded");

    const checklist = (await (await h.request("/v1/onboarding", as("owner"))).json()) as {
      items: { key: string; done: boolean }[];
    };
    expect(checklist.items.find((i) => i.key === "sample_data_removed")?.done).toBe(false);

    // A real person waits, by any path that writes one.
    await expect(
      ownerSql(
        `INSERT INTO person (location_id, status, nhs_number, given_name, family_name,
                             date_of_birth, allergy_status)
         VALUES ($1, 'active', '9990000999', 'Rae', 'Example', '1945-05-05', 'unknown')`,
        [NEW.locationId],
      ),
    ).rejects.toThrow(/remove_sample_data_first/);

    // Staff practise: a note and an allergy on a sample person, and a hold placed and released.
    const ada = people[0]?.id;
    await ownerSql(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body)
       VALUES ($1, $2, now() - interval '3 hours', 'other', 'Practice note about an invented person.')`,
      [ada, NEW.locationId],
    );
    await ownerSql(
      `INSERT INTO observation (person_id, location_id, chart, values, occurred_at)
       VALUES ($1, $2, 'fluid_intake', '{"ml":150}', now() - interval '3 hours')`,
      [ada, NEW.locationId],
    );
    await ownerSql(
      "INSERT INTO allergy (person_id, substance, severity) VALUES ($1, 'Practice substance', 'mild')",
      [ada],
    );
    await ownerSql(
      "INSERT INTO legal_hold (person_id, reason, released_at) VALUES ($1, 'Practice hold', now())",
      [ada],
    );

    // Removal needs a fresh step-up.
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const stale = await send("DELETE");
      expect(stale.status).toBe(403);
      expect(await codeOf(stale)).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }

    const removed = await send("DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ batchId: batch.batchId, people: SAMPLE_PEOPLE.length });
    expect(await ownerSql("SELECT id FROM person")).toEqual([]);
    expect(await ownerSql("SELECT id FROM care_note")).toEqual([]);
    expect(await ownerSql("SELECT id FROM observation")).toEqual([]);
    expect(await audits(REMOVED)).toEqual([
      expect.objectContaining({ outcome: "denied", reason: "nothing_to_remove" }),
      expect.objectContaining({ outcome: "denied", reason: "step_up_required" }),
      expect.objectContaining({
        outcome: "success",
        scope: {
          people: SAMPLE_PEOPLE.length,
          records: { allergy: 1, care_note: 1, legal_hold: 1, observation: 1 },
        },
      }),
    ]);
    expect(await audits(LOADED)).toEqual([
      expect.objectContaining({ outcome: "success", scope: { people: SAMPLE_PEOPLE.length } }),
      expect.objectContaining({ outcome: "denied", reason: "already_loaded" }),
    ]);
    expect(await codeOf(await send("DELETE"))).toBe("nothing_to_remove");

    // Once it has gone, a real person may be added.
    await ownerSql(
      `INSERT INTO person (location_id, status, nhs_number, given_name, family_name,
                           date_of_birth, allergy_status)
       VALUES ($1, 'active', '9990000999', 'Rae', 'Example', '1945-05-05', 'unknown')`,
      [NEW.locationId],
    );
  });
});
