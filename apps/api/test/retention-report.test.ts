import type { ProblemDetails, RetentionDue } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { RETENTION_REGISTRY } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepRetentionReports } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, OTHER } from "./support/harness";

/**
 * The retention sweep in report mode (retention sweeps plan 5.4, 5.8 and 5.9, slice 4; ADR-0135):
 * off by default, so nothing runs until an organisation turns it on; once on, one report row and
 * one audit event, counts only, and no record in any table is changed or removed. The report is
 * read through GET /v1/retention/due by tenant-wide holders of platform.retention.manage, and each
 * view is audited. The clock is injected.
 */

const json = async <T>(response: Response) => (await response.json()) as T;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TABLES = RETENTION_REGISTRY.map((e) => e.table).filter((t) => !t.includes("."));
/** Every registry table but the audit trail, which gains the sweep's own events (checked apart). */
const RECORD_TABLES = TABLES.filter((t) => t !== "audit_event");
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

describe("the retention report", () => {
  let h: Harness;

  const as = (user: keyof Harness["tokens"], path: string, tenant: string = DEMO.tenantId) =>
    h.request(path, { token: h.tokens[user], tenant });

  /** One statement as the owner in an organisation's context, in a transaction of its own. */
  async function asOwner<T extends pg.QueryResultRow>(
    tenantId: string,
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [tenantId],
      );
      const { rows } = await client.query<T>(text, params);
      await client.query("COMMIT");
      return rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** A fingerprint of every registry table in both organisations: row count and content hash. */
  async function fingerprint(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const tenantId of [DEMO.tenantId, OTHER.tenantId]) {
      for (const table of RECORD_TABLES) {
        const [row] = await asOwner<{ n: number; hash: string | null }>(
          tenantId,
          `SELECT count(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash
           FROM public.${table} t`,
        );
        result[`${tenantId}:${table}`] = `${row?.n}:${row?.hash ?? ""}`;
      }
    }
    return result;
  }

  const sweep = (now: Date) =>
    sweepRetentionReports(
      {
        workerPool: h.db.pool("harbour_worker"),
        appDb: h.handle.services.db,
        logger: createLogger("silent"),
      },
      now,
    );

  const reports = (tenantId: string) =>
    asOwner<{ n: number }>(tenantId, "SELECT count(*)::int AS n FROM retention_report").then(
      (r) => r[0]?.n,
    );

  const audited = (action: string) =>
    asOwner<{ resource_id: string | null; scope: Record<string, unknown> }>(
      DEMO.tenantId,
      "SELECT resource_id, scope FROM audit_event WHERE action = $1 ORDER BY seq",
      [action],
    );

  beforeAll(async () => {
    h = await createHarness();
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it("is off by default: the sweep writes nothing and the route says so", async () => {
    expect(await sweep(new Date("2030-01-01T00:00:00Z"))).toBe(0);
    expect(await reports(DEMO.tenantId)).toBe(0);
    const response = await as("owner", "/v1/retention/due");
    expect(response.status).toBe(200);
    expect(await json<RetentionDue>(response)).toEqual({ mode: "off", report: null });
    expect(await audited("platform.retention.sweep_reported")).toEqual([]);
  });

  it("refuses anyone without platform.retention.manage", async () => {
    for (const user of ["carer", "nurse"] as const) {
      const refused = await as(user, "/v1/retention/due");
      expect(refused.status).toBe(403);
      expect((await json<ProblemDetails>(refused)).code).toBeTruthy();
    }
  });

  it("in report mode counts by the clock, changes no record and writes counts only", async () => {
    await asOwner(
      DEMO.tenantId,
      "INSERT INTO feature_flag (flag_key, location_id, enabled) VALUES ('platform.retention.sweep_report', NULL, true)",
    );
    // A hold on someone with recorded allergies, so their allergy records count as held.
    const [person] = await asOwner<{ id: string }>(
      DEMO.tenantId,
      "SELECT person_id AS id FROM allergy ORDER BY person_id LIMIT 1",
    );
    await asOwner(
      DEMO.tenantId,
      "INSERT INTO legal_hold (person_id, reason) VALUES ($1, 'Claim notified by the insurer')",
      [person?.id],
    );
    const before = await fingerprint();
    const [{ seq } = { seq: 0 }] = await asOwner<{ seq: number }>(
      DEMO.tenantId,
      "SELECT coalesce(max(seq), 0)::int AS seq FROM audit_event",
    );

    // Before anything was made nothing can be due; far in the future, records whose trigger
    // has fired are.
    expect(await sweep(new Date("2001-01-01T00:00:00Z"))).toBe(1);
    expect(await sweep(new Date("2200-01-01T00:00:00Z"))).toBe(1);

    expect(await fingerprint()).toEqual(before);
    // The audit trail gains only the sweep's two reports.
    const added = await asOwner<{ action: string }>(
      DEMO.tenantId,
      "SELECT action FROM audit_event WHERE seq > $1 ORDER BY seq",
      [seq],
    );
    expect(added.map((a) => a.action)).toEqual([
      "platform.retention.sweep_reported",
      "platform.retention.sweep_reported",
    ]);
    expect(await reports(DEMO.tenantId)).toBe(2);
    // The other organisation's flag is off.
    expect(await reports(OTHER.tenantId)).toBe(0);

    const early = await asOwner<{ totals: Record<string, number> }>(
      DEMO.tenantId,
      "SELECT totals FROM retention_report ORDER BY as_of LIMIT 1",
    );
    expect(early[0]?.totals.due).toBe(0);

    const response = await as("owner", "/v1/retention/due");
    expect(response.status).toBe(200);
    const body = await json<RetentionDue>(response);
    expect(body.mode).toBe("report");
    const report = body.report;
    if (!report) throw new Error("no report");
    expect(report.asOf).toBe("2200-01-01T00:00:00.000Z");
    expect(report.totals.held).toBeGreaterThan(0);
    expect(report.totals.due).toBeGreaterThan(0);
    expect(report.tablesRead + report.tablesSkipped).toBe(RETENTION_REGISTRY.length);
    // Counts only: no record id, subject or date anywhere in the lines.
    expect(JSON.stringify(report.lines)).not.toMatch(UUID);
    // Every line adds up to the totals.
    const lineTotal = report.lines.reduce((n, l) => n + sum(l.counts), 0);
    expect(lineTotal).toBe(sum(report.totals));
    // Only the tables the application role may never read are left unread (equality
    // monitoring and released survey answers through their definers; invitations and operators
    // outside the organisation's rows): a later slice reads them.
    expect(
      report.lines
        .filter((l) => l.reason === "not_readable")
        .map((l) => l.table)
        .sort(),
    ).toEqual(["equality_monitoring", "invitation", "operator_user", "pulse_survey_response"]);

    const reported = await audited("platform.retention.sweep_reported");
    expect(reported).toHaveLength(2);
    expect(reported[1]?.resource_id).toBe(report.id);
    expect(JSON.stringify(reported[1]?.scope)).not.toMatch(UUID);
    const viewed = await audited("platform.retention.report_viewed");
    expect(viewed.at(-1)?.resource_id).toBe(report.id);
  });

  it("never shows one organisation's report to another", async () => {
    // This organisation's owner, naming the other organisation, is not a member of it.
    expect((await as("owner", "/v1/retention/due", OTHER.tenantId)).status).toBe(403);
    // The other organisation's manager, naming this organisation, is not a member of it either.
    expect((await as("rae", "/v1/retention/due", DEMO.tenantId)).status).toBe(403);
    // In their own organisation the fixture role lacks platform.retention.manage.
    expect((await as("rae", "/v1/retention/due", OTHER.tenantId)).status).toBe(403);
  });
});
