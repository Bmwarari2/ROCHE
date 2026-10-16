import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, OTHER } from "./support/harness";

/**
 * The onboarding decisions (PLAT-018; platform-completions.md rules 26 and 27): recorded only by a
 * holder of platform.onboarding.manage, refused when the rules say no (a decision with nothing
 * behind it, a kind the class does not take, an earlier safety case), each an append-only record
 * in the decider's own name, audited with refusals. Nothing crosses organisations.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (who: string, tenant: string = DEMO.tenantId) => ({ token: h.tokens[who], tenant });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

/** Reads as the owner role within the demo organisation. */
async function read<R extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    return (await client.query<R>(text, values)).rows;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const audits = (action: string) =>
  read<{ outcome: string; scope: unknown; reason: string | null }>(
    "SELECT outcome, scope, reason FROM audit_event WHERE action = $1 ORDER BY seq",
    [action],
  );

describe("rule 27 onboarding decisions are records, never ticks", () => {
  it("records a decision on a setting Harbour chose, and refuses one with nothing behind it", async () => {
    const defaults = await read<{ key: string }>(
      `SELECT DISTINCT key FROM rate_table
        WHERE tenant_id IS NULL AND (source ILIKE '%tenant default%' OR source ILIKE '%tenant setting%')
        ORDER BY key LIMIT 2`,
    );
    const [first, second] = defaults.map((r) => r.key);
    expect(first && second).toBeTruthy();
    expect(
      (
        await send("POST", "/v1/onboarding/setting-decisions", "manager", {
          rateKey: first,
          kind: "accepted",
        })
      ).status,
    ).toBe(403);
    const accepted = await send("POST", "/v1/onboarding/setting-decisions", "owner", {
      rateKey: first,
      kind: "accepted",
    });
    expect(accepted.status).toBe(201);
    const { id } = (await accepted.json()) as { id: string };
    expect(
      await read("SELECT rate_key, kind, decided_by FROM tenant_setting_decision WHERE id = $1", [
        id,
      ]),
    ).toEqual([{ rate_key: first, kind: "accepted", decided_by: DEMO.users.owner.id }]);
    for (const body of [
      { rateKey: second, kind: "set" },
      { rateKey: "not.a.setting", kind: "accepted" },
    ]) {
      const refused = await send("POST", "/v1/onboarding/setting-decisions", "owner", body);
      expect(refused.status).toBe(422);
      expect(await codeOf(refused)).toBe("decision_not_recordable");
    }
    const events = await audits("platform.setting.decided");
    expect(events.map((e) => e.outcome)).toEqual(["success", "denied", "denied"]);
    expect(events[0]?.scope).toEqual({ rateKey: first, kind: "accepted" });
    expect(events.slice(1).map((e) => e.reason)).toEqual([
      "no_own_setting",
      "not_a_tenant_default",
    ]);
  });

  it.each([
    ["accepts a class with a default", "care_record", "accepted", 201],
    ["marks a class the policy sets not used", "cctv", "not_used", 201],
    ["refuses marking a class with a default not used", "complaint", "not_used", 422],
    ["refuses lengthening with no period of its own", "complaint", "lengthened", 422],
    ["refuses a staff file option here", "staff_file.after_leaving", "accepted", 422],
    ["refuses a class not in the schedule", "made_up", "accepted", 422],
  ] as const)("retention: %s", async (_, recordClass, kind, status) => {
    const response = await send("POST", "/v1/onboarding/retention-decisions", "owner", {
      recordClass,
      kind,
    });
    expect(response.status).toBe(status);
    const rows = await read(
      "SELECT kind FROM retention_decision WHERE record_class = $1 AND kind = $2",
      [recordClass, kind],
    );
    expect(rows).toHaveLength(status === 201 ? 1 : 0);
  });

  it("chooses the staff file option against the version read", async () => {
    const version = async () =>
      (
        (await (await h.request("/v1/dpia", as("owner"))).json()) as {
          settings: { version: number };
        }
      ).settings.version;
    const current = await version();
    const stale = await send("PUT", "/v1/onboarding/staff-file-option", "owner", {
      option: "staff_file.to_75th_birthday",
      expectedVersion: current - 1,
    });
    expect(stale.status).toBe(409);
    const chosen = await send("PUT", "/v1/onboarding/staff-file-option", "owner", {
      option: "staff_file.to_75th_birthday",
      expectedVersion: current,
    });
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toEqual({
      option: "staff_file.to_75th_birthday",
      version: current + 1,
    });
    expect(
      await read("SELECT staff_file_option FROM tenant WHERE id = $1", [DEMO.tenantId]),
    ).toEqual([{ staff_file_option: "staff_file.to_75th_birthday" }]);
  });

  it("records the DCB0160 assessment only for the current safety case", async () => {
    const earlier = await send("POST", "/v1/onboarding/dcb0160", "owner", {
      safetyCaseVersion: "v-earlier",
    });
    expect(earlier.status).toBe(422);
    const current = await send("POST", "/v1/onboarding/dcb0160", "owner", {
      safetyCaseVersion: "v0.0",
    });
    expect(current.status).toBe(201);
    expect(await read("SELECT safety_case_version, recorded_by FROM dcb0160_record")).toEqual([
      { safety_case_version: "v0.0", recorded_by: DEMO.users.owner.id },
    ]);
    expect((await audits("platform.dcb0160.recorded")).map((e) => e.outcome)).toEqual([
      "denied",
      "success",
    ]);
  });

  it("refuses another organisation's owner, and anyone without the permission", async () => {
    for (const [who, tenant] of [
      ["owner", OTHER.tenantId],
      ["carer", DEMO.tenantId],
      ["nurse", DEMO.tenantId],
    ] as const) {
      const response = await h.request("/v1/onboarding/dcb0160", {
        method: "POST",
        body: { safetyCaseVersion: "v0.0" },
        ...as(who, tenant),
      });
      expect(response.status).toBe(403);
    }
  });
});
