import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { DEPENDENCY_TOOL_NOTICE, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The dependency tool through the API (scheduling.md section 12; CARE-004, SCHED-001; hazards
 * HZ-123 and HZ-011): the organisation's scale with expected_version and approval by a second
 * member; a person's category with the reason and who decided, idempotent, a stale current record
 * refused; required care hours with the method, the source and the notice, people not counted
 * named, no figure without a scale, refused to a scope that does not cover the location; every
 * write and care-record view audited with opaque ids only.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

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

/** The demo residents, all living at the demo location. */
const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const ADA = resident(1);
const BEN = resident(2);

/** Invented figures: the organisation's own scale. */
const DEFINITION = {
  periods: [
    { key: "day", label: "Day", startMinute: 480 },
    { key: "night", label: "Night", startMinute: 1200 },
  ],
  categories: [
    {
      key: "low",
      label: "Low",
      description: null,
      careMinutes: [
        { periodKey: "day", minutes: 60 },
        { periodKey: "night", minutes: 20 },
      ],
    },
    {
      key: "high",
      label: "High",
      description: "Two carers for transfers",
      careMinutes: [
        { periodKey: "day", minutes: 180 },
        { periodKey: "night", minutes: 60 },
      ],
    },
  ],
  skillMix: [{ skill: "registered_nurse", periodKey: "day", minimumStaff: 1 }],
  reviewIntervalDays: 30,
};

const today = () => ukIsoDate(new Date());
const tomorrow = () => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

interface VersionItem {
  id: string;
  state: string;
  version: number;
  issues: { problem: string }[];
  contributorIds: string[];
}
interface ScaleItem {
  id: string;
  version: number;
  current: VersionItem | null;
  draft: VersionItem | null;
}
interface Requirement {
  status: string;
  period: { key: string } | null;
  source: { kind: string; scaleName: string; versionNumber: number } | null;
  notice: string;
  requiredMinutes: number | null;
  careMinutes: number | null;
  oneToOneMinutes: number | null;
  complete: boolean;
  warnings: { code: string; personIds: string[] }[];
  method: string[];
  skillMix: { skill: string; minimumStaff: number }[];
}

const requirement = async (who: string, location: string, query: string) =>
  as(who, `/v1/locations/${location}/staffing-requirement?${query}`);

const record = (body: Record<string, unknown>, who = "manager", personId = ADA) =>
  as(who, `/v1/people/${personId}/dependency`, {
    method: "POST",
    body: {
      id: randomUUID(),
      kind: "initial",
      categoryKey: "high",
      oneToOne: [],
      effectiveFrom: today(),
      reason: "Needs two carers for every transfer",
      decidedBy: DEMO.users.manager.id,
      supersedesId: null,
      ...body,
    },
  });

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-123 the organisation's dependency scale", () => {
  let scale: ScaleItem;

  it("lets staff read the scales but only managers change them", async () => {
    const list = await as("carer", "/v1/dependency-scales");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { notice: string }).notice).toBe(DEPENDENCY_TOOL_NOTICE);
    const made = await as("carer", "/v1/dependency-scales", {
      method: "POST",
      body: { name: "Scale", locationId: DEMO.locationId, definition: DEFINITION },
    });
    expect(made.status).toBe(403);
  });

  it("makes a scale with its first draft, listing the draft's problems", async () => {
    const response = await as("manager", "/v1/dependency-scales", {
      method: "POST",
      body: {
        name: "Harbour House dependency scale",
        locationId: DEMO.locationId,
        definition: {
          ...DEFINITION,
          categories: [{ ...DEFINITION.categories[0], careMinutes: [] }],
        },
      },
    });
    expect(response.status).toBe(201);
    scale = (await response.json()) as ScaleItem;
    expect(scale.current).toBeNull();
    expect(scale.draft?.issues.map((i) => i.problem)).toEqual(["care_minutes_missing"]);
    const again = await as("manager", "/v1/dependency-scales", {
      method: "POST",
      body: { name: "Another", locationId: DEMO.locationId, definition: DEFINITION },
    });
    expect(again.status).toBe(409);
    const elsewhere = await as("manager", "/v1/dependency-scales", {
      method: "POST",
      body: { name: "Lodge", locationId: LODGE.locationId, definition: DEFINITION },
    });
    expect(elsewhere.status).toBe(403);
  });

  it("changes a draft only against the version loaded", async () => {
    const draft = scale.draft as VersionItem;
    const path = `/v1/dependency-scales/${scale.id}/versions/${draft.id}`;
    const stale = await as("manager", path, {
      method: "PUT",
      body: { definition: DEFINITION, version: draft.version + 1 },
    });
    expect(stale.status).toBe(409);
    const saved = await as("manager", path, {
      method: "PUT",
      body: { definition: DEFINITION, version: draft.version },
    });
    expect(saved.status).toBe(200);
    scale.draft = (await saved.json()) as VersionItem;
    expect(scale.draft.issues).toEqual([]);
  });

  it("is approved only by a member who neither wrote nor changed the draft", async () => {
    const draft = scale.draft as VersionItem;
    const path = `/v1/dependency-scales/${scale.id}/versions/${draft.id}/approve`;
    const own = await as("manager", path, { method: "POST", body: { version: draft.version } });
    expect(own.status).toBe(403);
    expect(((await own.json()) as { code: string }).code).toBe("separation_of_duties");
    const approved = await as("owner", path, { method: "POST", body: { version: draft.version } });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as VersionItem).state).toBe("approved");
    const events = await sql<{ event_type: string }>(
      "SELECT event_type FROM outbox_event WHERE aggregate_id = $1",
      [scale.id],
    );
    expect(events.map((e) => e.event_type)).toEqual(["scheduling.dependency_scale_approved"]);
  });

  it("renames against the scale's version and starts one new draft at a time", async () => {
    const renamed = await as("manager", `/v1/dependency-scales/${scale.id}`, {
      method: "PATCH",
      body: { name: "Harbour House scale", version: scale.version },
    });
    expect(renamed.status).toBe(200);
    const stale = await as("manager", `/v1/dependency-scales/${scale.id}`, {
      method: "PATCH",
      body: { name: "Again", version: scale.version },
    });
    expect(stale.status).toBe(409);
    const next = await as("manager", `/v1/dependency-scales/${scale.id}/versions`, {
      method: "POST",
    });
    expect(next.status).toBe(201);
    const second = (await next.json()) as VersionItem;
    expect(
      (await as("manager", `/v1/dependency-scales/${scale.id}/versions`, { method: "POST" }))
        .status,
    ).toBe(409);
    const unchanged = await as(
      "owner",
      `/v1/dependency-scales/${scale.id}/versions/${second.id}/approve`,
      {
        method: "POST",
        body: { version: second.version },
      },
    );
    expect(unchanged.status).toBe(409);
    const discarded = await as(
      "manager",
      `/v1/dependency-scales/${scale.id}/versions/${second.id}/discard`,
      { method: "POST", body: { reason: "Not needed yet", version: second.version } },
    );
    expect(discarded.status).toBe(200);
    const versions = await as("carer", `/v1/dependency-scales/${scale.id}/versions`);
    expect(((await versions.json()) as { items: VersionItem[] }).items.map((v) => v.state)).toEqual(
      ["discarded", "approved"],
    );
  });

  it("audits every change with opaque ids", async () => {
    const actions = await sql<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_event WHERE resource_id = $1 ORDER BY chain_position`,
      [scale.id],
    );
    expect(actions.filter((a) => a.outcome === "success").map((a) => a.action)).toEqual([
      "scheduling.dependency_scale.created",
      "scheduling.dependency_scale.edited",
      "scheduling.dependency_scale.approved",
      "scheduling.dependency_scale.renamed",
      "scheduling.dependency_scale.drafted",
      "scheduling.dependency_scale.discarded",
    ]);
    expect(actions.filter((a) => a.outcome === "denied").length).toBeGreaterThanOrEqual(3);
  });
});

describe("hazard HZ-123 a person's dependency category", () => {
  let first = "";

  it("records the category with the reason and who decided, once", async () => {
    const body = {
      id: randomUUID(),
      oneToOne: [{ periodKey: "day", minutes: 240 }],
    };
    const made = await record(body);
    expect(made.status).toBe(201);
    const item = (await made.json()) as { id: string; inForce: boolean; categoryLabel: string };
    expect(item).toMatchObject({ id: body.id, inForce: true, categoryLabel: "High" });
    first = item.id;
    expect((await record(body)).status).toBe(200);
    const different = await record({ ...body, reason: "Something else" });
    expect(different.status).toBe(409);
    expect(((await different.json()) as { code: string }).code).toBe("already_saved_differently");
  });

  it.each([
    ["a second first record", {}, 409],
    [
      "a review of a record that is not the current one",
      { kind: "review", supersedesId: randomUUID() },
      409,
    ],
    [
      "a category the scale lacks",
      { kind: "review", supersedesId: "FIRST", categoryKey: "medium" },
      422,
    ],
    [
      "a date after today",
      { kind: "review", supersedesId: "FIRST", effectiveFrom: "2099-01-01" },
      422,
    ],
    [
      "one-to-one for a period the scale lacks",
      { kind: "review", supersedesId: "FIRST", oneToOne: [{ periodKey: "twilight", minutes: 30 }] },
      422,
    ],
  ])("refuses %s", async (_, over, status) => {
    const body = { ...over } as Record<string, unknown>;
    if (body.supersedesId === "FIRST") body.supersedesId = first;
    expect((await record(body)).status).toBe(status);
  });

  it("refuses a member without care.dependency.assess, and one who has not used MFA", async () => {
    expect((await record({}, "carer", BEN)).status).toBe(403);
    expect((await record({}, "nurse", BEN)).status).toBe(403);
  });

  it("records a review and shows the history, the one in force marked, as an audited view", async () => {
    const review = await record({ kind: "review", supersedesId: first, categoryKey: "low" });
    expect(review.status).toBe(201);
    const read = await as("manager", `/v1/people/${ADA}/dependency`);
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      currentId: string;
      items: { id: string; inForce: boolean; kind: string }[];
      notice: string;
    };
    expect(body.items.map((i) => [i.kind, i.inForce])).toEqual([
      ["review", true],
      ["initial", false],
    ]);
    expect(body.currentId).toBe(body.items[0]?.id);
    expect(body.notice).toBe(DEPENDENCY_TOOL_NOTICE);
    const audit = await sql<{ action: string; scope: unknown; reason: string | null }>(
      "SELECT action, scope, reason FROM audit_event WHERE resource_id = $1 AND action LIKE 'care.dependency.%'",
      [ADA],
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["care.dependency.recorded", "care.dependency.viewed"]),
    );
    const text = JSON.stringify(audit);
    expect(text).not.toContain("transfer");
    expect(text).not.toContain('"low"');
  });

  it("hazard HZ-011 finds no other organisation's person", async () => {
    expect((await as("owner", `/v1/people/${OTHER.personId}/dependency`)).status).toBe(404);
  });
});

describe("hazard HZ-123 required care hours for a location and shift", () => {
  it("adds up the organisation's figures, names the people not counted, and shows the method", async () => {
    expect((await record({ categoryKey: "low" }, "manager", BEN)).status).toBe(201);
    const response = await requirement("manager", DEMO.locationId, `date=${tomorrow()}`);
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: Requirement[] };
    const day = items.find((i) => i.period?.key === "day") as Requirement;
    expect(day.status).toBe("computed");
    expect(day.source).toMatchObject({ kind: "organisation_scale", versionNumber: 1 });
    expect(day.notice).toBe(DEPENDENCY_TOOL_NOTICE);
    // Ada is now low (reviewed), Ben low; the other four demo residents have no category.
    expect(day.careMinutes).toBe(120);
    expect(day.requiredMinutes).toBe(120);
    expect(day.complete).toBe(false);
    expect(day.warnings.find((w) => w.code === "not_assessed")?.personIds).toHaveLength(4);
    expect(day.method.at(-1)).toContain("may be higher than shown");
    expect(day.skillMix).toEqual([{ skill: "registered_nurse", minimumStaff: 1 }]);
    const audit = await sql<{ action: string }>(
      "SELECT action FROM audit_event WHERE action = 'scheduling.staffing_requirement.viewed' AND outcome = 'success'",
    );
    expect(audit).toHaveLength(1);
  });

  it("returns one period when asked", async () => {
    const response = await requirement("owner", DEMO.locationId, `date=${tomorrow()}&period=night`);
    const { items } = (await response.json()) as { items: Requirement[] };
    expect(items.map((i) => i.period?.key)).toEqual(["night"]);
  });

  it("refuses a scope that does not cover the whole location, and a care worker", async () => {
    const outside = await requirement("manager", LODGE.locationId, `date=${tomorrow()}`);
    expect(outside.status).toBe(403);
    const refused = await sql<{ reason: string }>(
      "SELECT reason FROM audit_event WHERE action = 'scheduling.staffing_requirement.viewed' AND outcome = 'denied'",
    );
    expect(refused.map((r) => r.reason)).toContain("scope_not_whole_location");
    expect((await requirement("carer", DEMO.locationId, `date=${tomorrow()}`)).status).toBe(403);
  });

  it("gives no figure, never 0, where no scale is in force", async () => {
    const response = await requirement("owner", LODGE.locationId, `date=${tomorrow()}`);
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: Requirement[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "no_scale", requiredMinutes: null, complete: false });
    expect(items[0]?.warnings[0]?.code).toBe("no_scale");
  });

  it("hazard HZ-011 finds no other organisation's location", async () => {
    expect((await requirement("owner", OTHER.locationId, `date=${tomorrow()}`)).status).toBe(404);
  });

  it("shows no scale once the scale is archived", async () => {
    const list = (await (await as("manager", "/v1/dependency-scales")).json()) as {
      items: ScaleItem[];
    };
    const scale = list.items[0] as ScaleItem;
    const archived = await as("manager", `/v1/dependency-scales/${scale.id}/archive`, {
      method: "POST",
      body: { reason: "Replaced by the organisation's scale", version: scale.version },
    });
    expect(archived.status).toBe(200);
    const response = await requirement("manager", DEMO.locationId, `date=${tomorrow()}`);
    const { items } = (await response.json()) as { items: Requirement[] };
    expect(items.map((i) => i.status)).toEqual(["no_scale"]);
    expect(
      (
        await as("manager", `/v1/dependency-scales/${scale.id}`, {
          method: "PATCH",
          body: { name: "Again", version: scale.version + 1 },
        })
      ).status,
    ).toBe(409);
  });
});
