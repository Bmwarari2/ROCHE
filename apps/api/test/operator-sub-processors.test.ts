import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness, OTHER } from "./support/harness";

/**
 * Thapsus's side of sub-processor notices (platform-completions.md rules 24 and 25): an admin
 * with a fresh step-up announces one no sooner than the longest notice period among the
 * organisations it affects, and each affected organisation's lead is told; objections are read
 * and resolved only through definer functions that check the admin, need an open objection and
 * write the organisation's audit trail.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const op = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[who], ...init });
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

async function ownerIn(text: string, values: unknown[] = [], tenant: string = DEMO.tenantId) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenant],
    );
    const result = await client.query<Record<string, unknown>>(text, values);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Runs the worker's outbox relay once, as the worker would. */
async function relay() {
  const deps = {
    workerPool: h.db.pool("harbour_worker"),
    appDb: h.handle.services.db,
    logger: createLogger("silent"),
  };
  await relayOutbox(deps, outboxHandlers(deps));
}

const announce = (who: string, body: Record<string, unknown>) =>
  op(who, "/operator/sub-processor-notices", { method: "POST", body });
const SENTRY = {
  subProcessorKey: "sentry",
  kind: "replacement",
  use: { kind: "always" },
  effectiveFrom: inDays(45),
};

describe("rules 24 and 25, Thapsus's side", () => {
  let noticeId = "";

  it("lets only an admin with a fresh step-up announce, no sooner than the notice period", async () => {
    expect((await announce("opsSupport", SENTRY)).status).toBe(403);
    expect((await announce("manager", SENTRY)).status).toBe(403);
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.opsAdmin?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const stale = await announce("opsAdmin", SENTRY);
      expect(stale.status).toBe(403);
      expect(await codeOf(stale)).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
    // A suspended organisation's data is still processed, so it is counted and told.
    await ownerIn(
      "UPDATE tenant SET status = 'suspended' WHERE id = $1",
      [OTHER.tenantId],
      OTHER.tenantId,
    );
    const soon = await announce("opsAdmin", { ...SENTRY, effectiveFrom: inDays(5) });
    expect(soon.status).toBe(422);
    expect(await codeOf(soon)).toBe("notice_too_short");
    const announced = await announce("opsAdmin", SENTRY);
    expect(announced.status).toBe(201);
    const body = (await announced.json()) as { id: string; affectedOrganisations: number };
    noticeId = body.id;
    expect(body.affectedOrganisations).toBeGreaterThanOrEqual(2);
    // Each organisation's trail records it in the same transaction; the worker tells its owners
    // (no lead is named yet), once however often the event is delivered.
    for (const tenant of [DEMO.tenantId, OTHER.tenantId]) {
      const trail = await ownerIn(
        "SELECT action FROM audit_event WHERE action = 'platform.sub_processor.announced' AND resource_id = $1",
        [noticeId],
        tenant,
      );
      expect(trail).toHaveLength(1);
    }
    await relay();
    await ownerIn("UPDATE outbox_event SET published_at = NULL WHERE aggregate_id = $1", [
      noticeId,
    ]);
    await relay();
    const told = await ownerIn(
      "SELECT count(*)::int AS n FROM notification WHERE kind = 'platform.sub_processor.notice_announced' AND source_id = $1",
      [noticeId],
    );
    const owners = await ownerIn(
      `SELECT count(DISTINCT ra.tenant_user_id)::int AS n FROM role_assignment ra
         JOIN role r ON r.id = ra.role_id
        WHERE r.key = 'owner' AND ra.deleted_at IS NULL`,
    );
    expect(told[0]?.n).toBe(owners[0]?.n);
    await ownerIn(
      "UPDATE tenant SET status = 'active' WHERE id = $1",
      [OTHER.tenantId],
      OTHER.tenantId,
    );
  });

  it("affects only organisations whose configuration uses the sub-processor", async () => {
    const unused = await announce("opsAdmin", {
      subProcessorKey: "anthropic",
      kind: "new",
      use: { kind: "ai_provider", provider: "anthropic" },
      effectiveFrom: inDays(1),
    });
    expect(unused.status).toBe(201);
    expect(((await unused.json()) as { affectedOrganisations: number }).affectedOrganisations).toBe(
      0,
    );
  });

  it("reads and resolves an open objection only through the definer functions", async () => {
    await ownerIn("UPDATE tenant SET data_protection_lead_id = $1 WHERE id = $2", [
      DEMO.users.owner.id,
      DEMO.tenantId,
    ]);
    const grounds = "Our DPIA does not cover error data leaving the UK for this service.";
    const objected = await h.request(`/v1/sub-processor-notices/${noticeId}/object`, {
      method: "POST",
      body: { grounds },
      token: h.tokens.owner,
      tenant: DEMO.tenantId,
    });
    expect(objected.status).toBe(201);

    const objections = `/operator/sub-processor-notices/${noticeId}/objections`;
    const resolution = `/operator/tenants/${DEMO.tenantId}/sub-processor-notices/${noticeId}/resolution`;
    const ended = { method: "POST", body: { resolution: "services_ended" } };
    expect((await op("opsSupport", objections)).status).toBe(403);
    expect((await op("opsSupport", resolution, ended)).status).toBe(403);
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.opsAdmin?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      expect(await codeOf(await op("opsAdmin", objections))).toBe("step_up_required");
      expect(await codeOf(await op("opsAdmin", resolution, ended))).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
    const read = await op("opsAdmin", `/operator/sub-processor-notices/${noticeId}/objections`);
    expect(read.status).toBe(200);
    const { items } = (await read.json()) as {
      items: { tenantId: string; grounds: string; resolvedAt: string | null }[];
    };
    expect(items).toEqual([
      expect.objectContaining({ tenantId: DEMO.tenantId, grounds, resolvedAt: null }),
    ]);

    const resolve = (tenant: string, resolution = "objection_withdrawn") =>
      op("opsAdmin", `/operator/tenants/${tenant}/sub-processor-notices/${noticeId}/resolution`, {
        method: "POST",
        body: { resolution },
      });
    expect((await resolve(OTHER.tenantId)).status).toBe(409);
    expect((await resolve(DEMO.tenantId)).status).toBe(201);
    expect((await resolve(DEMO.tenantId)).status).toBe(409);
    await relay();
    const resolvedTold = await ownerIn(
      "SELECT recipient_tenant_user_id AS who FROM notification WHERE kind = 'platform.sub_processor.objection_resolved' AND source_id = $1",
      [noticeId],
    );
    expect(resolvedTold.map((r) => r.who)).toEqual([DEMO.users.owner.id]);
    const state = (await (
      await h.request("/v1/sub-processors", { token: h.tokens.owner, tenant: DEMO.tenantId })
    ).json()) as { notices: { id: string; state: string }[] };
    expect(state.notices.find((n) => n.id === noticeId)?.state).toBe("objection_resolved");
    const trail = await ownerIn(
      `SELECT action, scope::text AS scope FROM audit_event
        WHERE resource_id = $1 AND action LIKE 'platform.sub_processor.objection_%' ORDER BY seq`,
      [noticeId],
    );
    expect(trail.map((e) => e.action)).toEqual([
      "platform.sub_processor.objection_read",
      "platform.sub_processor.objection_resolved",
    ]);
    for (const e of trail) expect(String(e.scope)).not.toContain("DPIA does not cover");
    const missing = await op(
      "opsAdmin",
      `/operator/tenants/${DEMO.tenantId}/sub-processor-notices/${OTHER.tenantId}/resolution`,
      { method: "POST", body: { resolution: "services_ended" } },
    );
    expect(missing.status).toBe(404);
  });

  it("hazard HZ-011 gives the operator role no direct access to responses", async () => {
    const client = await h.db.pool("harbour_operator").connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
      await client.query("SAVEPOINT s");
      await expect(client.query("SELECT id FROM sub_processor_response")).rejects.toThrow(
        /permission denied/,
      );
      await client.query("ROLLBACK TO SAVEPOINT s");
      // The functions take the caller from app.operator_id: none set, no admin.
      await expect(
        client.query("SELECT * FROM app.sub_processor_objections($1, NULL)", [noticeId]),
      ).rejects.toThrow(/operator_not_admin/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    // The application role cannot run any of them.
    const app = await h.db.pool("harbour_app").connect();
    try {
      for (const call of [
        `SELECT app.announce_sub_processor_notice('x_y', 'new', '{"kind":"always"}', now(), ARRAY[]::uuid[], NULL)`,
        `SELECT * FROM app.sub_processor_objections('${noticeId}', NULL)`,
        `SELECT app.resolve_sub_processor_objection('${DEMO.tenantId}', '${noticeId}', 'services_ended', NULL)`,
      ]) {
        await expect(app.query(call)).rejects.toThrow(/permission denied/);
      }
    } finally {
      app.release();
    }
  });
});
