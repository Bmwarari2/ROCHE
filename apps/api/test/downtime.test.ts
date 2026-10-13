import { DEMO } from "@harbour/db/seed";
import { DOWNTIME_PACK_SECTIONS } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The downtime pack API (operations.md sections 5 and 12; OPS-028; hazard HZ-021): the pack for
 * the people receiving care at a location now, built again when it no longer serves them, printed
 * with the header on every page, the nightly job once per location and night, the rebuild after a
 * lifecycle event, and where the paper MAR and PEEPs are kept.
 */

let h: Harness;

const url = (locationId: string = DEMO.locationId) => `/v1/locations/${locationId}/downtime-pack`;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
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
  } finally {
    client.release();
  }
}

interface PackBody {
  id: string;
  source: string;
  built: boolean;
  header: string[];
  freshness: { state: string };
  pages: {
    personId: string;
    status: string;
    away: string | null;
    sections: { key: string; critical: boolean; status: string; note: string | null }[];
  }[];
}

const pack = async (who = "manager") => {
  const response = await as(who, url());
  expect(response.status).toBe(200);
  return (await response.json()) as PackBody;
};

const livePeople = async () =>
  sql<{ id: string }>(
    "SELECT id FROM person WHERE location_id = $1 AND status IN ('active', 'on_leave', 'in_hospital')",
    [DEMO.locationId],
  );

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-021 the downtime pack", () => {
  it("hazard HZ-021 the downtime pack contains every required section for every current resident", async () => {
    const body = await pack();
    expect(body.built).toBe(true);
    expect(body.source).toBe("server_on_demand");
    expect(body.pages.map((p) => p.personId).sort()).toEqual(
      (await livePeople()).map((p) => p.id).sort(),
    );
    for (const page of body.pages) {
      expect(page.sections.map((s) => s.key)).toEqual(DOWNTIME_PACK_SECTIONS.map((s) => s.key));
      for (const section of page.sections.filter((s) => s.critical && s.status !== "included")) {
        expect(section.note, `${page.personId} ${section.key}`).toBeTruthy();
      }
      const medicines = page.sections.find((s) => s.key === "medicines_due");
      expect(medicines?.status).toBe("held_elsewhere");
      expect(medicines?.note).toMatch(/not set in Harbour/);
    }
    expect(body.freshness.state).toBe("current");
    expect(body.header[0]).toMatch(/^Downtime pack for /);
    const again = await pack();
    expect(again).toMatchObject({ id: body.id, built: false });
  });

  it("builds the pack again when someone's status or the places change", async () => {
    const first = await pack();
    const [someone] = await livePeople();
    await sql("UPDATE person SET status = 'in_hospital' WHERE id = $1", [someone?.id]);
    const after = await pack();
    expect(after.built).toBe(true);
    expect(after.pages.find((p) => p.personId === someone?.id)?.away).toBe("In hospital");
    expect(after.id).not.toBe(first.id);

    const mar = "The MAR folder in the clinical room";
    await sql(
      `UPDATE location SET downtime_mar_location = $2, downtime_places_confirmed_by = $3
       WHERE id = $1`,
      [DEMO.locationId, mar, DEMO.users.manager.id],
    );
    const confirmed = await pack();
    expect(confirmed.built).toBe(true);
    const medicines = confirmed.pages[0]?.sections.find((s) => s.key === "medicines_due");
    expect(medicines?.note).toBe(`Not kept in Harbour yet. Use ${mar}.`);
  });

  it("is only for holders of operations.downtime.read where the location is", async () => {
    expect((await as("carer", url())).status).toBe(403);
    expect((await as("manager", url(LODGE.locationId))).status).toBe(404);
    expect((await as("owner", url(LODGE.locationId))).status).toBe(200);
    const other = await h.request(url(), { token: h.tokens.rae, tenant: OTHER.tenantId });
    expect([403, 404]).toContain(other.status);
  });

  it("audits building and opening the pack", async () => {
    const rows = await sql<{ action: string }>(
      "SELECT DISTINCT action FROM audit_event WHERE resource_type = 'downtime_pack'",
    );
    expect(rows.map((r) => r.action).sort()).toEqual(
      expect.arrayContaining([
        "operations.downtime_pack.generated",
        "operations.downtime_pack.opened",
      ]),
    );
  });
});
