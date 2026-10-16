import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, OTHER } from "./support/harness";

/**
 * The onboarding checklist (PLAT-018; platform-completions.md rules 26 and 27): every item from
 * the organisation's records; decisions are append-only records with who and when, made only by
 * a holder of platform.onboarding.manage and refused when the rules say no; nothing crosses
 * organisations. Every decision is audited, refusals too.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

type Item = {
  key: string;
  done: boolean;
  reason: string;
  outstanding: string[];
  people?: { personId: string; gaps: string[] }[];
};
type Checklist = {
  items: Item[];
  total: number;
  blockers: string[];
  currentSafetyCaseVersion: string;
  staffFileOption: string | null;
  version: number;
};

const as = (who: string, tenant: string = DEMO.tenantId) => ({ token: h.tokens[who], tenant });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const checklist = async (who = "owner") =>
  (await (await h.request("/v1/onboarding", as(who))).json()) as Checklist;
const item = async (key: string) => (await checklist()).items.find((i) => i.key === key) as Item;

describe("rule 26 the onboarding checklist, worked out from state", () => {
  it("lists every item from the organisation's records, for those who may read it", async () => {
    const list = await checklist();
    expect(list.items).toHaveLength(list.total);
    expect(list.currentSafetyCaseVersion).toBe("v0.0");
    expect(list.items.find((i) => i.key === "dcb0160_recorded")?.done).toBe(false);
    expect(list.blockers).toContain("dcb0160_recorded");
    // Hazard HZ-001: each person still outstanding is listed with what they lack.
    const people = list.items.find((i) => i.key === "people_ready");
    expect(people?.people?.map((p) => p.personId)).toEqual(people?.outstanding);
    for (const p of people?.people ?? []) expect(p.gaps.length).toBeGreaterThan(0);
    // The Registered Manager reads it; a care worker and another organisation's owner do not.
    expect((await h.request("/v1/onboarding", as("manager"))).status).toBe(200);
    expect((await h.request("/v1/onboarding", as("carer"))).status).toBe(403);
    expect((await h.request("/v1/onboarding", as("owner", OTHER.tenantId))).status).toBe(403);
  });

  it("closes each item a decision answers, and only that one", async () => {
    const rates = await item("rates_reviewed");
    const key = rates.outstanding[0] ?? "";
    expect(
      (
        await send("POST", "/v1/onboarding/setting-decisions", "owner", {
          rateKey: key,
          kind: "accepted",
        })
      ).status,
    ).toBe(201);
    const after = await item("rates_reviewed");
    expect(after.outstanding).not.toContain(key);
    expect(after.outstanding).toHaveLength(rates.outstanding.length - 1);

    await send("POST", "/v1/onboarding/retention-decisions", "owner", {
      recordClass: "care_record",
      kind: "accepted",
    });
    const retention = await item("retention_reviewed");
    expect(retention.outstanding).not.toContain("care_record");
    expect(retention.outstanding).toContain("staff_file");
    const { version } = await checklist();
    await send("PUT", "/v1/onboarding/staff-file-option", "owner", {
      option: "staff_file.to_75th_birthday",
      expectedVersion: version,
    });
    const chosen = await checklist();
    expect(chosen.staffFileOption).toBe("staff_file.to_75th_birthday");
    expect(chosen.items.find((i) => i.key === "retention_reviewed")?.outstanding).not.toContain(
      "staff_file",
    );

    expect((await item("dcb0160_recorded")).done).toBe(false);
    await send("POST", "/v1/onboarding/dcb0160", "owner", {
      safetyCaseVersion: chosen.currentSafetyCaseVersion,
    });
    const recorded = await checklist();
    expect(recorded.items.find((i) => i.key === "dcb0160_recorded")?.done).toBe(true);
    expect(recorded.blockers).not.toContain("dcb0160_recorded");
  });
});

describe("hazard HZ-014 the go-live check reads the escalation policy links", () => {
  const asOwner = async (text: string, values: unknown[] = []) => {
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
      await client.query(text, values);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  it("counts a validated tool in use anywhere until its policy is linked", async () => {
    const linked = await item("escalation_policies_linked");
    expect(linked.done).toBe(false);
    expect(linked.outstanding).toContain("braden");
    expect((await checklist()).blockers).toContain("escalation_policies_linked");
    await asOwner(
      "UPDATE feature_flag SET enabled = false WHERE flag_key = 'care.tool.braden' AND location_id IS NULL",
    );
    expect((await item("escalation_policies_linked")).outstanding).not.toContain("braden");
    // Switched on at one home only, it is in use again.
    await asOwner(
      "INSERT INTO feature_flag (location_id, flag_key, enabled) VALUES ($1, 'care.tool.braden', true)",
      [DEMO.locationId],
    );
    expect((await item("escalation_policies_linked")).outstanding).toContain("braden");
  });
});
