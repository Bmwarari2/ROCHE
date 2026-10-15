import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { DOWNTIME_PACK_SECTIONS } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDowntimePacks, outboxHandlers, type TaskDeps } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";
import { pdfPages } from "./support/pdf-text";

/**
 * The downtime pack API (operations.md sections 5 and 12; OPS-028; hazard HZ-021): the pack for
 * the people receiving care at a location now, built again when it no longer serves them, printed
 * with the header on every page, the nightly job once per location and night, the rebuild after a
 * lifecycle event, and where the paper MAR and PEEPs are kept.
 */

let h: Harness;
let deps: TaskDeps;

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
  rebuildFailed: boolean;
  header: string[];
  freshness: { state: string };
  pages: {
    personId: string;
    displayName: string;
    status: string;
    away: string | null;
    roomLabel: string | null;
    sections: { key: string; critical: boolean; status: string; note: string | null }[];
    content: {
      allergies: { status: string; allergies?: { substance: string }[] };
      resuscitation: { kind: string }[];
    };
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

const LIMIT_KEY = "downtime_pack.requests_per_hour";
/** The organisation's own figure for the pack request limit (the default is per member and hour). */
const setPackLimit = (value: number) =>
  sql(
    `WITH changed AS (
       UPDATE rate_table SET value = $3 WHERE tenant_id = $1 AND key = $2 RETURNING 1)
     INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source,
       verification_status)
     SELECT $1, $2, $3, 'count', 'all', '2000-01-01', 'Test figure', 'to-verify'
     WHERE NOT EXISTS (SELECT 1 FROM changed)`,
    [DEMO.tenantId, LIMIT_KEY, value],
  );

beforeAll(async () => {
  h = await createHarness();
  deps = {
    workerPool: h.db.pool("harbour_worker"),
    appDb: createDatabase(h.db.pool("harbour_app")),
    logger: createLogger("silent"),
  };
  // These tests open the pack more often than a member would in an hour.
  await setPackLimit(1000);
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

  it("prints the header worked out now on every page, and each person's page names them", async () => {
    const response = await as("manager", `${url()}?format=pdf`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    const pages = pdfPages(new Uint8Array(await response.arrayBuffer()));
    expect(pages.length).toBeGreaterThan((await livePeople()).length);
    for (const lines of pages) {
      const text = lines.join(" ");
      expect(text).toMatch(/Downtime pack for /);
      expect(text).toMatch(/Information as at .* Use until /);
    }
    expect(pages.slice(1).every((lines) => lines.join(" ").match(/NHS number 999/))).toBe(true);
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
    const set = await as("manager", `/v1/locations/${DEMO.locationId}/downtime-places`, {
      method: "PUT",
      body: { marLocation: mar, peepLocation: "The red fire file", confirm: true },
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      marLocation: mar,
      confirmedBy: DEMO.users.manager.id,
    });
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
    const places = await as("nurse", `/v1/locations/${DEMO.locationId}/downtime-places`, {
      method: "PUT",
      body: { marLocation: "Anywhere", peepLocation: "Anywhere", confirm: true },
    });
    expect(places.status).toBe(403);
  });

  it("audits building, opening and printing the pack", async () => {
    const rows = await sql<{ action: string }>(
      "SELECT DISTINCT action FROM audit_event WHERE resource_type = 'downtime_pack'",
    );
    expect(rows.map((r) => r.action).sort()).toEqual(
      expect.arrayContaining([
        "operations.downtime_pack.generated",
        "operations.downtime_pack.opened",
        "operations.downtime_pack.printed",
      ]),
    );
  });
});

describe("hazard HZ-021 nightly packs and rebuilds", () => {
  it("builds each location's nightly pack once a night, and asks for unconfirmed places", async () => {
    const now = new Date();
    expect(await buildDowntimePacks(deps, now)).toBeGreaterThanOrEqual(2);
    expect(await buildDowntimePacks(deps, now)).toBe(0);
    const nightly = await sql<{ location_id: string; generated_by: string | null }>(
      "SELECT location_id, generated_by FROM downtime_pack WHERE source = 'server_nightly'",
    );
    expect(nightly.filter((r) => r.location_id === LODGE.locationId)).toEqual([
      { location_id: LODGE.locationId, generated_by: null },
    ]);
    const tasks = await sql<{ location_id: string }>(
      "SELECT location_id FROM task WHERE kind = 'operations.downtime_places' AND status = 'open'",
    );
    // The demo home's places were confirmed above; the Lodge's never were.
    expect(tasks.map((t) => t.location_id)).toEqual([LODGE.locationId]);
  });

  it("hazard HZ-021 rebuilds the pack when someone on the latest one has moved", async () => {
    const [someone] = await livePeople();
    // Moved to the Lodge: the home's latest pack names them, so the home's holders cannot open it.
    await sql("UPDATE person SET location_id = $2, status = 'active' WHERE id = $1", [
      someone?.id,
      LODGE.locationId,
    ]);
    const handler = outboxHandlers(deps).get("people.person.returned");
    const event = {
      id: "0199e000-0000-7000-8000-00000000e001",
      tenantId: DEMO.tenantId,
      eventType: "people.person.returned",
      aggregateId: someone?.id ?? "",
      payload: { personId: someone?.id, locationId: DEMO.locationId },
    };
    await handler?.(event);
    await handler?.(event);
    const rebuilt = await sql<{ location_id: string; generated_by: string | null; ids: string[] }>(
      `SELECT location_id, generated_by, person_ids::text[] AS ids FROM downtime_pack
       WHERE source = 'server_rebuild' ORDER BY location_id`,
    );
    expect(
      rebuilt.map((r) => [r.location_id, r.generated_by, r.ids.includes(someone?.id ?? "")]),
    ).toEqual(
      [
        [DEMO.locationId, null, false],
        [LODGE.locationId, null, true],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const latest = await pack();
    expect(latest.built).toBe(false);
    expect(latest.pages.some((p) => p.personId === someone?.id)).toBe(false);
  });
});

describe("hazard HZ-021 a pack that no longer serves is built again, safely (#45 review round 1)", () => {
  const auth = () => h.db.pool("harbour_auth");
  const rawToken = (token: string) => token.split(".")[0];
  const packCount = async () =>
    Number(
      (
        await sql<{ n: string }>("SELECT count(*) AS n FROM downtime_pack WHERE location_id = $1", [
          DEMO.locationId,
        ])
      )[0]?.n,
    );
  const page = (body: PackBody, personId: string) =>
    body.pages.find((p) => p.personId === personId);
  const someone = async () =>
    (
      await sql<{ id: string }>(
        `SELECT p.id FROM person p WHERE p.location_id = $1 AND p.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM advance_care_record r WHERE r.person_id = p.id
             AND r.kind = 'dnacpr' AND r.status = 'active' AND r.deleted_at IS NULL)
         ORDER BY p.id LIMIT 1`,
        [DEMO.locationId],
      )
    )[0]?.id as string;

  it("hazard HZ-015 hazard HZ-007 hazard HZ-001 builds the pack again after a new DNACPR, an allergy or a room swap", async () => {
    const id = await someone();
    await pack();
    expect((await pack()).built).toBe(false);
    await sql(
      `INSERT INTO advance_care_record (person_id, kind, status, cpr_decision, clinician_name,
         clinician_role, completed_on)
       VALUES ($1, 'dnacpr', 'active', 'do_not_attempt_cpr', 'Dr Ada Example', 'GP', CURRENT_DATE)`,
      [id],
    );
    const afterDnacpr = await pack();
    expect(afterDnacpr.built).toBe(true);
    expect(page(afterDnacpr, id)?.content.resuscitation.map((r) => r.kind)).toContain("dnacpr");
    await sql("UPDATE person SET allergy_status = 'has_allergies' WHERE id = $1", [id]);
    await sql(
      "INSERT INTO allergy (person_id, substance, severity, status) VALUES ($1, 'Chlorhexidine', 'severe', 'active')",
      [id],
    );
    const afterAllergy = await pack();
    expect(afterAllergy.built).toBe(true);
    expect(page(afterAllergy, id)?.content.allergies.allergies?.map((a) => a.substance)).toContain(
      "Chlorhexidine",
    );
    await sql("UPDATE person SET room_label = 'Room 42' WHERE id = $1", [id]);
    const afterRoom = await pack();
    expect(afterRoom.built).toBe(true);
    expect(page(afterRoom, id)?.roomLabel).toBe("Room 42");
  });

  it("hazard HZ-007 prints each person's own current allergies only", async () => {
    const [first, second] = await livePeople();
    await sql("UPDATE person SET allergy_status = 'has_allergies' WHERE id = ANY ($1::uuid[])", [
      [first?.id, second?.id],
    ]);
    await sql(
      `INSERT INTO allergy (person_id, substance, severity, status, deleted_at) VALUES
         ($1, 'Amoxicillin', 'severe', 'confirmed', NULL),
         ($1, 'Strawberries', 'mild', 'resolved', NULL),
         ($1, 'Ibuprofen gel', 'mild', 'entered-in-error', NULL),
         ($1, 'Codeine', 'mild', 'inactive', NULL),
         ($1, 'Plasters', 'mild', 'refuted', NULL),
         ($1, 'Kiwi fruit', 'mild', 'active', now())`,
      [first?.id],
    );
    const body = await pack();
    const own = page(body, first?.id ?? "")?.content.allergies.allergies?.map((a) => a.substance);
    expect(own).toContain("Amoxicillin");
    for (const gone of ["Strawberries", "Ibuprofen gel", "Codeine", "Plasters", "Kiwi fruit"]) {
      expect(own).not.toContain(gone);
    }
    const others = body.pages
      .filter((p) => p.personId !== first?.id)
      .flatMap((p) => p.content.allergies.allergies?.map((a) => a.substance) ?? []);
    expect(others).not.toContain("Amoxicillin");
  });

  it("builds once when two people read at the same time, and reuses the pack when asked to build", async () => {
    await sql("UPDATE person SET room_label = 'Room 43' WHERE id = $1", [await someone()]);
    const before = await packCount();
    const [one, two] = await Promise.all([pack(), pack("owner")]);
    expect(await packCount()).toBe(before + 1);
    expect(one.id).toBe(two.id);
    expect([one.built, two.built].sort()).toEqual([false, true]);
    const asked = await as("manager", url(), { method: "POST" });
    expect(asked.status).toBe(201);
    expect(await asked.json()).toMatchObject({ id: one.id, built: false });
  });

  it("serves the latest pack, saying it could not be built again, when a build fails", async () => {
    const latest = await pack();
    await sql("ALTER TABLE downtime_pack ADD CONSTRAINT lane_a_refuse_all CHECK (false) NOT VALID");
    try {
      await sql("UPDATE person SET room_label = 'Room 44' WHERE id = $1", [await someone()]);
      const body = await pack();
      expect(body).toMatchObject({ id: latest.id, built: false, rebuildFailed: true });
      expect(body.header.join(" ")).toMatch(/could not be rebuilt just now/);
      const failed = await sql(
        `SELECT 1 FROM audit_event WHERE action = 'operations.downtime_pack.generated'
           AND outcome = 'error' AND reason = 'rebuild_failed'`,
      );
      expect(failed.length).toBeGreaterThan(0);
    } finally {
      await sql("ALTER TABLE downtime_pack DROP CONSTRAINT lane_a_refuse_all");
    }
  });

  it("needs a fresh sign-in to build on request, but not to read", async () => {
    const session = "UPDATE auth.session SET created_at = $2 WHERE token = $1";
    await auth().query(session, [rawToken(h.tokens.owner ?? ""), new Date(Date.now() - 3_600_000)]);
    try {
      const asked = await as("owner", url(), { method: "POST" });
      expect(asked.status).toBe(403);
      expect(((await asked.json()) as { code: string }).code).toBe("step_up_required");
      const printed = await as("owner", `${url()}?format=pdf`);
      expect(printed.status).toBe(403);
      expect(((await printed.json()) as { code: string }).code).toBe("step_up_required");
      expect((await as("owner", url())).status).toBe(200);
    } finally {
      await auth().query(session, [rawToken(h.tokens.owner ?? ""), new Date()]);
    }
  });

  it("audits a location out of reach as denied", async () => {
    expect((await as("manager", url(LODGE.locationId))).status).toBe(404);
    const denied = await sql(
      `SELECT 1 FROM audit_event WHERE action = 'operations.downtime_pack.opened'
         AND outcome = 'denied' AND resource_id = $1`,
      [LODGE.locationId],
    );
    expect(denied.length).toBeGreaterThan(0);
  });

  it("limits how often a member opens packs", async () => {
    await setPackLimit(1);
    try {
      const limited = await as("manager", url());
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
    } finally {
      await setPackLimit(1000);
    }
  });
});

describe("hazard HZ-021 the printed pack (#46 review round 1)", () => {
  const printedPages = async () => {
    const response = await as("manager", `${url()}?format=pdf`);
    expect(response.status).toBe(200);
    return pdfPages(new Uint8Array(await response.arrayBuffer()));
  };

  it("hazard HZ-001 names on every page's footer the person whose content is on it, a continuation page included", async () => {
    const [someone] = await livePeople();
    await sql(
      `INSERT INTO contact (person_id, role, given_name, family_name, phone)
       SELECT $1, 'next_of_kin', 'Contact', 'Example ' || n, '01632 960' || lpad(n::text, 3, '0')
       FROM generate_series(1, 60) AS n`,
      [someone?.id],
    );
    const names = (await pack()).pages.map((p) => p.displayName);
    const pages = await printedPages();
    expect(pages[0]?.join(" ")).toMatch(/\d+ people receiving care, in room order\./);
    expect(pages[0]?.join(" ")).toContain("Photos are not printed in this pack");
    let owner: string | null = null;
    let continuations = 0;
    for (const lines of pages.slice(1)) {
      const heading = lines.find((line) => names.includes(line)) ?? null;
      if (heading) owner = heading;
      else continuations += 1;
      expect(owner, lines.join(" ")).not.toBeNull();
      expect(lines.at(-1) ?? "").toContain(`${owner},`);
      if (heading) {
        expect(lines.join(" ")).toContain(
          "Confirm who the person is with a colleague who knows them.",
        );
      }
    }
    expect(continuations).toBeGreaterThan(0);
  });

  it("hazard HZ-015 prints that an ADRT is held beside the CPR decision", async () => {
    const [someone] = await livePeople();
    await sql(
      `INSERT INTO advance_care_record (person_id, kind, status, clinician_name, clinician_role,
         completed_on, details)
       VALUES ($1, 'adrt', 'active', 'Dr Ada Example', 'GP', CURRENT_DATE,
         'Refuses mechanical ventilation')`,
      [someone?.id],
    );
    const body = await pack();
    const name = body.pages.find((p) => p.personId === someone?.id)?.displayName ?? "";
    const pages = await printedPages();
    const own = pages.filter((lines) => (lines.at(-1) ?? "").startsWith(`${name},`)).flat();
    expect(own.join(" ")).toContain(
      "ADRT also held: read it before any decision about resuscitation.",
    );
    expect(own.join(" ")).not.toContain("Resuscitation status not recorded");
  });

  it("refuses HEAD on the pack", async () => {
    const head = await h.request(url(), {
      method: "HEAD",
      token: h.tokens.manager,
      tenant: DEMO.tenantId,
    });
    expect(head.status).toBe(405);
  });
});
