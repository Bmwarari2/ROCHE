import { createHash } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { withAdminClient } from "@harbour/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness, OTHER } from "./support/harness";

/**
 * Payroll and pension exports through the API (scheduling.md section 19; SCHED-008; ADR-0013,
 * ADR-0097). A locked run is exported as a file, reproducibly. Step-up is required. A draft run and
 * a member with no payroll reference are refused. A re-export needs confirming and is flagged.
 * Xero is refused until connected, then sent through the mock. Audit events carry ids only. All the
 * people here are invented.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const post = (who: string, path: string, body: unknown) => as(who, path, { method: "POST", body });
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const SET = "0199f776-0000-7000-8000-0000000000a1";
const LOCKED = "0199f776-0000-7000-8000-0000000000b1";
const DRAFT = "0199f776-0000-7000-8000-0000000000b2";
const CARER = DEMO.users.carer.id;
const NURSE = DEMO.users.nurse.id;

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

type Result = {
  export: {
    id: string;
    reexport: boolean;
    contentSha256: string;
    lineCount: number;
    outcome: string;
  };
  file: { fileName: string; content: string } | null;
  message: string;
};

beforeAll(async () => {
  h = await createHarness({ PAYROLL_XERO: "mock" });
  // Test setup only: a locked run with two lines, and a draft run, written past the pay guards
  // (slice 36's own tests cover how a run is calculated and locked).
  await withAdminClient(async (c) => {
    await c.query("SET session_replication_role = replica");
    await c.query(
      `INSERT INTO pay_rule_set (id, tenant_id, name, version_number, effective_from, role_rates, status,
         approved_by, approved_at)
       VALUES ($1, $2, 'Standard', 1, '2026-04-06', '{"care_worker": 1300}', 'approved', $3, now())`,
      [SET, DEMO.tenantId, DEMO.users.manager.id],
    );
    await c.query(
      `INSERT INTO pay_run (id, tenant_id, frequency, period_start, period_end, rule_set_id, nation,
         calculation, status, locked_by, locked_at)
       VALUES ($1, $3, 'monthly', '2026-10-01', '2026-10-31', $4, 'england', 1, 'locked', $5, now()),
              ($2, $3, 'monthly', '2026-11-01', '2026-11-30', $4, 'england', 1, 'draft', NULL, NULL)`,
      [LOCKED, DRAFT, DEMO.tenantId, SET, DEMO.users.manager.id],
    );
    for (const [member, basic] of [
      [CARER, 192000],
      [NURSE, 280000],
    ] as const) {
      await c.query(
        `INSERT INTO pay_run_line (tenant_id, run_id, calculation, member_id, paid_minutes, nmw_minutes,
           basic_pence, premium_pence, sleep_in_pence, on_call_pence, mileage_pence, nmw_top_up_pence,
           rolled_up_holiday_pence, ssp_pence, total_pence, ae_category, qualifying_earnings_pence,
           working, inputs, input_hash)
         VALUES ($1, $2, 1, $3, 9600, 9600, $4, 0, 0, 0, 0, 0, 0, 0, $4, 'eligible_jobholder', 72250,
           '[]', '{}', $5)`,
        [DEMO.tenantId, LOCKED, member, basic, "d".repeat(64)],
      );
    }
    await c.query(
      `INSERT INTO pay_profile (tenant_id, member_id, frequency, payroll_reference)
       VALUES ($1, $2, 'monthly', 'W001')`,
      [DEMO.tenantId, CARER],
    );
    await c.query(
      "INSERT INTO pay_profile (tenant_id, member_id, frequency) VALUES ($1, $2, 'monthly')",
      [DEMO.tenantId, NURSE],
    );
  }, h.db.name);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("SCHED-008 exporting a locked pay run", () => {
  it("refuses a draft run, and a run with a member who has no payroll reference", async () => {
    const draft = await post("owner", `/v1/pay-runs/${DRAFT}/exports`, { format: "brightpay_csv" });
    expect(draft.status).toBe(409);
    expect(((await draft.json()) as { code: string }).code).toBe("run_not_locked");
    const missing = await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
      format: "brightpay_csv",
    });
    expect(missing.status).toBe(422);
    const body = (await missing.json()) as { code: string; detail: string };
    expect(body.code).toBe("payroll_reference_missing");
    expect(body.detail).toContain(NURSE);
    await sql("UPDATE pay_profile SET payroll_reference = 'W002' WHERE member_id = $1", [NURSE]);
  });

  it("needs a fresh sign-in, and the permission for the whole organisation", async () => {
    await ageSession(h.db.pool("harbour_auth"), h.tokens.owner?.split(".")[0] ?? "", 3600);
    const stale = await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
      format: "brightpay_csv",
    });
    expect(stale.status).toBe(403);
    await ageSession(h.db.pool("harbour_auth"), h.tokens.owner?.split(".")[0] ?? "", 0);
    // A home's Registered Manager holds it only at their home: refused.
    const local = await post("manager", `/v1/pay-runs/${LOCKED}/exports`, {
      format: "brightpay_csv",
    });
    expect(local.status).toBe(403);
    expect((await as("carer", `/v1/pay-runs/${LOCKED}/exports`)).status).toBe(403);
  });

  it("exports a file made from the locked run, reproducibly, and flags a re-export", async () => {
    const first = await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
      format: "brightpay_csv",
    });
    expect(first.status).toBe(201);
    const made = (await first.json()) as Result;
    expect(made.export).toMatchObject({ reexport: false, lineCount: 2, outcome: "generated" });
    expect(made.file?.content).toContain('"W001","160.00","1920.00"');
    expect(made.file?.content).not.toContain(CARER);
    expect(made.export.contentSha256).toBe(sha(made.file?.content ?? ""));
    // Again, without confirming: refused; confirmed: the same file, flagged.
    const again = await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
      format: "brightpay_csv",
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("reexport_needs_confirming");
    const confirmed = (await (
      await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
        format: "brightpay_csv",
        confirmReexport: true,
      })
    ).json()) as Result;
    expect(confirmed.export.reexport).toBe(true);
    expect(confirmed.export.contentSha256).toBe(made.export.contentSha256);
    expect(confirmed.message).toMatch(/exported before/);
    const list = (await (await as("owner", `/v1/pay-runs/${LOCKED}/exports`)).json()) as {
      items: { reexport: boolean }[];
    };
    expect(list.items.map((i) => i.reexport).sort()).toEqual([false, true]);
    const audit = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'scheduling.payroll_export.created'",
    );
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toMatch(/W001|1920|192000/);
  });

  it("reuses the first export's references, so a later change does not alter a re-export", async () => {
    const before = (await (
      await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
        format: "sage_csv",
        confirmReexport: true,
      })
    ).json()) as Result;
    await sql("UPDATE pay_profile SET payroll_reference = 'W009' WHERE member_id = $1", [NURSE]);
    const after = (await (
      await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
        format: "sage_csv",
        confirmReexport: true,
      })
    ).json()) as Result;
    expect(after.export.contentSha256).toBe(before.export.contentSha256);
    expect(after.file?.content).toContain('"W002"');
    expect(after.file?.content).not.toContain("W009");
  });

  it("lets only one of two exports at once go out as the first", async () => {
    await sql("UPDATE pay_profile SET payroll_reference = 'W002' WHERE member_id = $1", [NURSE]);
    await withAdminClient(async (c) => {
      await c.query("SET session_replication_role = replica");
      await c.query("UPDATE pay_run SET calculation = 2 WHERE id = $1", [LOCKED]);
      await c.query("UPDATE pay_run_line SET calculation = 2 WHERE run_id = $1", [LOCKED]);
    }, h.db.name);
    const [one, two] = await Promise.all([
      post("owner", `/v1/pay-runs/${LOCKED}/exports`, { format: "brightpay_csv" }),
      post("owner", `/v1/pay-runs/${LOCKED}/exports`, { format: "brightpay_csv" }),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
  });

  it("refuses Xero until the organisation connects it, then sends through the mock", async () => {
    const before = await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
      format: "xero_payroll_uk",
      confirmReexport: true,
    });
    expect(before.status).toBe(409);
    expect(((await before.json()) as { code: string }).code).toBe("integration_not_connected");
    // The caller cannot name a secret: the connection names its organisation's own, and it never
    // comes back.
    const made = await post("owner", "/v1/payroll-connections", {
      provider: "xero_payroll_uk",
      externalOrganisationId: "xero-org-demo",
    });
    expect(made.status).toBe(201);
    const connection = (await made.json()) as { id: string };
    expect(JSON.stringify(connection)).not.toMatch(/payroll\//);
    // No tokens under that name in the store yet: refused, nothing sent, the attempt recorded as
    // failed.
    const noTokens = await post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
      format: "xero_payroll_uk",
      confirmReexport: true,
    });
    expect(noTokens.status).toBe(409);
    expect(h.handle.payrollMock.received).toHaveLength(0);
    // What the OAuth handshake will do: tokens under the organisation's own secret name.
    h.handle.payrollSecrets.put(
      `payroll/${DEMO.tenantId}/xero_payroll_uk/${connection.id}`,
      "invented-test-token",
    );
    const send = () =>
      post("owner", `/v1/pay-runs/${LOCKED}/exports`, {
        format: "xero_payroll_uk",
        confirmReexport: true,
      });
    const sent = await send();
    expect(sent.status).toBe(201);
    const result = (await sent.json()) as Result & { export: { externalRef: string | null } };
    expect(result.export).toMatchObject({ outcome: "sent", externalRef: "mock-batch-1" });
    expect(result.file).toBeNull();
    const [batch] = h.handle.payrollMock.received;
    expect(batch?.xeroTenantId).toBe("xero-org-demo");
    expect(batch?.batch.employees.map((e) => e.employeeId)).toEqual(["W001", "W002"]);
    expect(JSON.stringify(batch)).not.toContain(CARER);
    // A refusal is failed; no answer is unknown, which says to check Xero first.
    h.handle.payrollMock.failNext = "rejected";
    expect(((await (await send()).json()) as Result).export.outcome).toBe("failed");
    h.handle.payrollMock.failNext = "no_answer";
    const unknown = (await (await send()).json()) as Result;
    expect(unknown.export.outcome).toBe("unknown");
    expect(unknown.message).toMatch(/Check in Xero/);
    const recorded = await sql<{ action: string }>(
      "SELECT action FROM audit_event WHERE action = 'scheduling.payroll_export.result_recorded'",
    );
    expect(recorded.length).toBeGreaterThanOrEqual(4);
    // Disconnected: refused again.
    const live = (await (await as("owner", "/v1/payroll-connections")).json()) as {
      items: { id: string; version: number; status: string }[];
    };
    const current = live.items.find((i) => i.id === connection.id);
    expect(
      (
        await post("owner", `/v1/payroll-connections/${connection.id}/disconnect`, {
          version: current?.version,
        })
      ).status,
    ).toBe(200);
    expect((await send()).status).toBe(409);
  });

  it("keeps another organisation's run out of reach", async () => {
    const elsewhere = await h.request(`/v1/pay-runs/${LOCKED}/exports`, {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
    });
    expect([403, 404]).toContain(elsewhere.status);
  });
});
