import { beforeAll, describe, expect, it } from "vitest";
import { NEVER_EVICT_TABLES, OFFLINE_WINDOW_TABLES } from "../src/client/schema";
import { offlineWindowDays } from "../src/client/window";
import { readSyncConfig, type SyncTokenClaims } from "../src/streams/index";
import { compile, type DeviceDataset, ids, type SourceRows, syncFor } from "./support/simulator";

/**
 * Care record streams (care.md section 6). Logical replication bypasses row-level security, so
 * these tests alone prove which care rows reach a device (hazard HZ-011): only the token's tenant,
 * only people in the token's scope, and point-of-care entries only for the days of the offline
 * window in the token. Connection parameters are under the device's control, so hostile values are
 * tried too: none of them may widen the scope or the window (security review S1). Invented people
 * and values only.
 */

const A = "tenant-a";
const B = "tenant-b";
const TODAY = "2026-10-11";
const NOW = new Date(`${TODAY}T10:00:00Z`);
/** The window the API puts in the token (the tenant's `mobile.offline_window_days`, 7 here). */
const WINDOW_DAYS = offlineWindowDays(NOW, 7);
const OLD = "2026-09-01T09:00:00.000000Z";
const RECENT = `${TODAY}T09:00:00.000000Z`;

const CARE_TABLES = [...NEVER_EVICT_TABLES, ...OFFLINE_WINDOW_TABLES].filter(
  (t) => !["person", "allergy", "location"].includes(t),
);

interface PersonFixture {
  readonly id: string;
  readonly tenant: string;
  readonly location: string;
  readonly status?: string;
}

const people: readonly PersonFixture[] = [
  { id: "ada", tenant: A, location: "loc-a-north" },
  { id: "ben", tenant: A, location: "loc-a-north" },
  { id: "cara", tenant: A, location: "loc-a-south" },
  { id: "dev", tenant: B, location: "loc-b-river" },
  // No longer receiving care at the manager's location: their care record must leave devices.
  { id: "eve", tenant: A, location: "loc-a-north", status: "discharged" },
  { id: "fay", tenant: A, location: "loc-a-north", status: "deceased" },
  { id: "gus", tenant: A, location: "loc-a-north", status: "archived" },
  { id: "hal", tenant: A, location: "loc-a-north", status: "in_hospital" },
];

function entry(table: string, p: PersonFixture, suffix: string, occurredAt: string) {
  const base = {
    id: `${table}-${p.id}-${suffix}`,
    tenant_id: p.tenant,
    person_id: p.id,
    location_id: p.location,
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    device_time: occurredAt,
    device_id: "device-fixture",
    late_entry: 0,
    clock_drift: 0,
    supersedes_id: null,
    correction_reason: null,
    created_by: "user-fixture",
  };
  switch (table) {
    case "care_note":
      return {
        ...base,
        category: "personal_care",
        body: "Invented note",
        tags: "[]",
        attachment_document_ids: "[]",
      };
    case "observation":
      return {
        ...base,
        chart: "fluid_intake",
        values: '{"chart":"fluid_intake","ml":200}',
        flags: "{}",
      };
    case "body_map_mark":
      return {
        ...base,
        view: "front",
        region: "shin",
        side: "left",
        mark_type: "bruise",
        bruise_explained: 1,
        status: "present",
        photo_document_id: "photo-fixture",
      };
    case "activity_record":
      return { ...base, activity: "Gardening", format: "one_to_one", attendance: "attended" };
    default:
      return {
        ...base,
        kind: "facilitated_visit",
        visitor_name: "Invented visitor",
        restrictions_applied: 0,
      };
  }
}

function careRows(p: PersonFixture): SourceRows {
  const plan = (id: string, status: string) => ({
    id: `${id}-${p.id}`,
    tenant_id: p.tenant,
    person_id: p.id,
    location_id: p.location,
    status,
    published_version: status === "draft" ? null : 1,
    summary: "Invented plan",
    review_due_on: "2027-01-01",
    deleted_at: null,
    updated_at: "2025-10-01T09:00:00Z",
    version: 1,
  });
  const section = (planId: string) => ({
    id: `section-${planId}-${p.id}`,
    tenant_id: p.tenant,
    person_id: p.id,
    plan_id: `${planId}-${p.id}`,
    domain: "mobility",
    need: "Invented need",
    deleted_at: null,
    version: 1,
  });
  const action = (planId: string) => ({
    id: `action-${planId}-${p.id}`,
    tenant_id: p.tenant,
    person_id: p.id,
    plan_id: `${planId}-${p.id}`,
    section_id: `section-${planId}-${p.id}`,
    action: "Invented action",
    deleted_at: null,
    version: 1,
  });
  const windowed = Object.fromEntries(
    OFFLINE_WINDOW_TABLES.map((t) => [t, [entry(t, p, "recent", RECENT), entry(t, p, "old", OLD)]]),
  );
  return {
    person_care_profile: [
      {
        id: `profile-${p.id}`,
        tenant_id: p.tenant,
        person_id: p.id,
        iddsi_food_level: "5",
        spo2_scale2: 0,
        skin_risk: "at_risk",
        deleted_at: null,
        version: 1,
      },
    ],
    // A plan published a year ago is still the plan in force: never evicted by the window.
    care_plan: [
      plan("plan-active", "active"),
      plan("plan-draft", "draft"),
      plan("plan-old", "superseded"),
    ],
    care_plan_section: ["plan-active", "plan-draft", "plan-old"].map(section),
    care_plan_action: ["plan-active", "plan-draft", "plan-old"].map(action),
    risk_assessment: ["active", "closed"].map((status) => ({
      id: `risk-${status}-${p.id}`,
      tenant_id: p.tenant,
      person_id: p.id,
      template_key: "falls",
      hazard: "Invented hazard",
      status,
      answers: '{"secret":"not for devices"}',
      deleted_at: null,
      assessed_on: "2025-01-01",
      version: 1,
    })),
    assessment: [OLD, "2025-01-01T09:00:00.000000Z"].map((at, i) => ({
      id: `assessment-${i}-${p.id}`,
      tenant_id: p.tenant,
      person_id: p.id,
      location_id: p.location,
      tool_key: "must",
      tool_version: "bapen-2011",
      score: 1,
      band: "medium",
      occurred_at: at,
      answers: '{"weightKg":60}',
      workings: "[]",
    })),
    advance_care_record: (
      [
        ["dnacpr", "active"],
        ["respect", "withdrawn"],
      ] as const
    ).map(([kind, status]) => ({
      id: `acr-${kind}-${p.id}`,
      tenant_id: p.tenant,
      person_id: p.id,
      kind,
      status,
      cpr_decision: "do_not_attempt_cpr",
      completed_on: "2024-05-01",
      document_id: "document-fixture",
      deleted_at: null,
      version: 1,
    })),
    ...windowed,
  };
}

function merge(...sets: SourceRows[]): SourceRows {
  const out: SourceRows = {};
  for (const set of sets) {
    for (const [table, rows] of Object.entries(set)) out[table] = [...(out[table] ?? []), ...rows];
  }
  return out;
}

const source: SourceRows = merge(
  {
    person: people.map((p) => ({
      id: p.id,
      tenant_id: p.tenant,
      location_id: p.location,
      status: p.status ?? "active",
      given_name: p.id,
      family_name: "Example",
    })),
    person_assignment: [
      { id: "pa-1", tenant_id: A, tenant_user_id: "carer-a", person_id: "ada", deleted_at: null },
      {
        id: "pa-2",
        tenant_id: A,
        tenant_user_id: "carer-a",
        person_id: "ben",
        deleted_at: "2026-10-10T00:00:00Z",
      },
      { id: "pa-3", tenant_id: B, tenant_user_id: "agency", person_id: "dev", deleted_at: null },
      { id: "pa-4", tenant_id: A, tenant_user_id: "agency", person_id: "cara", deleted_at: null },
    ],
  },
  ...people.map(careRows),
);

const claims = (overrides: Partial<SyncTokenClaims>): Partial<SyncTokenClaims> => ({
  location_ids: [],
  people_location_ids: [],
  offline_days: WINDOW_DAYS,
  ...overrides,
});

/** Every care row id on the device, across all twelve tables. */
function careIds(device: DeviceDataset): string[] {
  return CARE_TABLES.flatMap((t) => ids(device, t)).sort();
}

/** The people whose care rows are on the device. */
function peopleOnDevice(device: DeviceDataset): string[] {
  const owners = new Set<string>();
  for (const t of CARE_TABLES) {
    for (const row of device.tables[t]?.values() ?? []) owners.add(String(row.person_id));
  }
  return [...owners].sort();
}

let hydrated: ReturnType<typeof compile>["hydrated"];

beforeAll(() => {
  const compiled = compile(readSyncConfig());
  expect(compiled.errors).toEqual([]);
  hydrated = compiled.hydrated;
});

describe("hazard HZ-011 care record streams (assigned scope)", () => {
  it("gives a care worker the care record of assigned people only", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    expect(peopleOnDevice(device)).toEqual(["ada"]);
    for (const table of CARE_TABLES) expect(ids(device, table).length, table).toBeGreaterThan(0);
  });

  it("never sends a person who is not assigned, whatever window the device sends", async () => {
    const everyDay = { offline_days: [OLD.slice(0, 10), TODAY, "2025-01-01", "2026-10-12"] };
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A }),
      everyDay,
    );
    expect(peopleOnDevice(device)).toEqual(["ada"]);
    expect(careIds(device).some((id) => id.includes("-cara") || id.includes("-ben"))).toBe(false);
  });

  it("takes a person's care record off the device once the assignment has ended", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    expect(careIds(device).filter((id) => id.endsWith("-ben"))).toEqual([]);
  });

  it("ignores connection parameters that try to widen the scope", async () => {
    const hostile = {
      offline_days: [OLD.slice(0, 10), TODAY],
      tenant_id: B,
      sub: "agency",
      people_location_ids: ["loc-a-north", "loc-a-south", "loc-b-river"],
      person_id: "cara",
    };
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A }),
      hostile,
    );
    expect(peopleOnDevice(device)).toEqual(["ada"]);
    expect(ids(device, "care_note")).toEqual(["care_note-ada-recent"]);
  });
});

describe("hazard HZ-011 care record streams (location scope)", () => {
  it("gives a manager everyone receiving care at their locations and nobody elsewhere", async () => {
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "manager-a", tenant_id: A, people_location_ids: ["loc-a-north"] }),
    );
    expect(peopleOnDevice(device)).toEqual(["ada", "ben", "hal"]);
  });

  it("takes the care record of people discharged, deceased or archived off managers' devices", async () => {
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "manager-a", tenant_id: A, people_location_ids: ["loc-a-north"] }),
    );
    const gone = careIds(device).filter((id) =>
      ["-eve", "-fay", "-gus"].some((p) => id.includes(p)),
    );
    expect(gone).toEqual([]);
    // Someone in hospital is still a resident: their record stays for their return.
    expect(ids(device, "care_plan")).toContain("plan-active-hal");
  });
});

describe("hazard HZ-011 care record streams (tenant isolation)", () => {
  it("gives a token for one tenant nothing from another, even with the other's location ids", async () => {
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "manager-a", tenant_id: A, people_location_ids: ["loc-b-river"] }),
    );
    expect(careIds(device)).toEqual([]);
  });

  it("keeps an agency worker's two tenants apart", async () => {
    const inA = await syncFor(hydrated, source, claims({ sub: "agency", tenant_id: A }));
    expect(peopleOnDevice(inA)).toEqual(["cara"]);
    const inB = await syncFor(hydrated, source, claims({ sub: "agency", tenant_id: B }));
    expect(peopleOnDevice(inB)).toEqual(["dev"]);
  });

  it("gives a token without a tenant no care record at all", async () => {
    const device = await syncFor(hydrated, source, { sub: "carer-a", offline_days: WINDOW_DAYS });
    expect(careIds(device)).toEqual([]);
  });
});

describe("offline window (ADR-0011)", () => {
  it("keeps point-of-care entries for the days of the window only", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    for (const table of OFFLINE_WINDOW_TABLES) {
      expect(ids(device, table), table).toEqual([`${table}-ada-recent`]);
    }
  });

  it("hazard HZ-028 takes entries off the device when their day leaves the window", async () => {
    const before = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A, offline_days: [TODAY, OLD.slice(0, 10)] }),
    );
    expect(ids(before, "care_note")).toEqual(["care_note-ada-old", "care_note-ada-recent"]);
    const after = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A, offline_days: [TODAY] }),
    );
    expect(ids(after, "care_note")).toEqual(["care_note-ada-recent"]);
  });

  it("hazard HZ-028 ignores a window sent by the device: only the token's window counts", async () => {
    const widened = { offline_days: [OLD.slice(0, 10), TODAY, "2025-01-01"] };
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A, offline_days: [TODAY] }),
      widened,
    );
    for (const table of OFFLINE_WINDOW_TABLES) {
      expect(ids(device, table), table).toEqual([`${table}-ada-recent`]);
    }
  });

  it("sends no entries when the token has no window, whatever the device sends (fails closed)", async () => {
    const noWindow = { sub: "carer-a", tenant_id: A, location_ids: [], people_location_ids: [] };
    const device = await syncFor(hydrated, source, noWindow, { offline_days: WINDOW_DAYS });
    for (const table of OFFLINE_WINDOW_TABLES) expect(ids(device, table), table).toEqual([]);
  });

  it("hazard HZ-002 reference data for assigned people is never evicted while the assignment stands", async () => {
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A, offline_days: [TODAY] }),
    );
    expect(ids(device, "care_plan")).toEqual(["plan-active-ada"]);
    expect(ids(device, "assessment")).toEqual(["assessment-0-ada", "assessment-1-ada"]);
    expect(ids(device, "advance_care_record")).toEqual(["acr-dnacpr-ada"]);
    expect(ids(device, "person_care_profile")).toEqual(["profile-ada"]);
    // With no window at all, the reference data still arrives.
    const noWindow = await syncFor(hydrated, source, {
      sub: "carer-a",
      tenant_id: A,
      location_ids: [],
      people_location_ids: [],
    });
    expect(ids(noWindow, "risk_assessment")).toEqual(["risk-active-ada"]);
  });
});

describe("what reaches the device", () => {
  it("hazard HZ-024 only the active care plan, with its own sections and actions", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    expect(ids(device, "care_plan")).toEqual(["plan-active-ada"]);
    expect(ids(device, "care_plan_section")).toEqual(["section-plan-active-ada"]);
    expect(ids(device, "care_plan_action")).toEqual(["action-plan-active-ada"]);
  });

  it("hazard HZ-015 only advance care records in force, and active risk assessments", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    expect(ids(device, "advance_care_record")).toEqual(["acr-dnacpr-ada"]);
    expect(ids(device, "risk_assessment")).toEqual(["risk-active-ada"]);
  });

  it("never sends answers, workings, documents, photos or device ids the screens do not need", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    const columns = (table: string) =>
      new Set([...(device.tables[table]?.values() ?? [])].flatMap((row) => Object.keys(row)));
    expect(columns("assessment").has("answers")).toBe(false);
    expect(columns("assessment").has("workings")).toBe(false);
    expect(columns("risk_assessment").has("answers")).toBe(false);
    expect(columns("advance_care_record").has("document_id")).toBe(false);
    expect(columns("body_map_mark").has("photo_document_id")).toBe(false);
    expect(columns("care_note").has("attachment_document_ids")).toBe(false);
    expect(columns("care_note").has("device_id")).toBe(false);
  });

  it("renames observation values so the device never needs a reserved word", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    const row = device.tables.observation?.get("observation-ada-recent");
    expect(row?.chart_values).toBe('{"chart":"fluid_intake","ml":200}');
    expect(row).not.toHaveProperty("values");
  });
});
