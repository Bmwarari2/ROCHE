import type { AuditList, DolsItem, DolsList } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, OTHER } from "./support/harness";

/**
 * The DoLS list for a location (INSI-001 role dashboards; HZ-020): requests waiting for an
 * outcome, authorisations inside their first reminder window and authorisations past their end,
 * soonest ending first, for the people the caller may see. Demo residents 1 to 3 are assigned to
 * the care worker; the Registered Manager covers Harbour House.
 */

let h: Harness;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const LIST = `/v1/locations/${DEMO.locationId}/dols`;

const as = (user: keyof Harness["tokens"], path: string, body?: unknown) =>
  h.request(path, {
    token: h.tokens[user],
    tenant: DEMO.tenantId,
    ...(body ? { method: "POST", body } : {}),
  });

async function record(n: number, body: Record<string, unknown>): Promise<DolsItem> {
  const response = await as("manager", `/v1/people/${resident(n)}/dols`, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as DolsItem;
}

const granted = (fromDaysAgo: number, toDays: number) => ({
  type: "standard",
  requestedAt: ago((fromDaysAgo + 10) * DAY),
  outcome: "granted",
  outcomeAt: ago(fromDaysAgo * DAY),
  grantedFrom: ago(fromDaysAgo * DAY),
  grantedTo: toDays >= 0 ? ahead(toDays * DAY) : ago(-toDays * DAY),
});

const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  ids.requested = (
    await record(4, { type: "standard", requestedAt: ago(12 * DAY), precededByUrgent: false })
  ).id;
  ids.expiring = (await record(2, granted(300, 5))).id;
  ids.expired = (await record(5, granted(360, -3))).id;
  ids.active = (await record(6, granted(30, 200))).id;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-020 the DoLS list for a location", () => {
  it("lists what needs attention, soonest ending first, with requests last", async () => {
    const response = await as("manager", LIST);
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as DolsList;
    expect(items.map((i) => [i.id, i.status])).toEqual([
      [ids.expired, "expired"],
      [ids.expiring, "expiring"],
      [ids.requested, "requested"],
    ]);
    expect(items.some((i) => i.id === ids.active)).toBe(false);
  });

  it("shows a care worker only the people they may see", async () => {
    const response = await as("carer", LIST);
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as DolsList;
    expect(items.map((i) => i.id)).toEqual([ids.expiring]);
  });

  it("is not found for a location in another organisation or one that does not exist", async () => {
    expect((await as("manager", `/v1/locations/${OTHER.locationId}/dols`)).status).toBe(404);
    expect(
      (await as("manager", "/v1/locations/0194d000-0000-7000-8000-00000000ffff/dols")).status,
    ).toBe(404);
  });

  it("refuses a member without care.plan.read", async () => {
    // The agency worker is a member of the demo organisation with no role there.
    expect((await as("agency", LIST)).status).toBe(403);
  });

  it("records the view in the audit trail by location, never content", async () => {
    const response = await as(
      "owner",
      `/v1/audit?resourceType=location&resourceId=${DEMO.locationId}&limit=200`,
    );
    expect(response.status).toBe(200);
    const audit = (await response.json()) as AuditList;
    const entry = audit.items.find((e) => e.action === "care.dols.location_list");
    expect(entry).toMatchObject({ resourceType: "location", resourceId: DEMO.locationId });
  });
});
