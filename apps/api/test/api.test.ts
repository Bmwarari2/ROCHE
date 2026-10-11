import type {
  AuditList,
  DeviceSessionList,
  Me,
  NotificationList,
  PersonList,
  ProblemDetails,
  RateValue,
  SyncToken,
  SyncUploadResult,
  TaskList,
} from "@harbour/contracts";
import { DEVICE_HEADER, TENANT_HEADER } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { offlineWindowDays, SYNC_TOKEN_AUDIENCE, SYNC_TOKEN_ISSUER } from "@harbour/sync/streams";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { createHarness, type Harness, LODGE, OTHER, PASSWORD } from "./support/harness";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const json = async <T>(response: Response) => (await response.json()) as T;

/** A query as the table owner inside one tenant: row-level security is forced for the owner too. */
async function asTenant<T extends Record<string, unknown>>(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenantId],
    );
    const result = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
const demo = (
  token: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown } = {},
) => h.request(path, { token: h.tokens[token], tenant: DEMO.tenantId, ...init });

describe("health and contract", () => {
  it("reports health without a session", async () => {
    const response = await h.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", database: "ok" });
  });

  it("publishes an OpenAPI 3.1 document covering the routes", async () => {
    const doc = await json<{ openapi: string; paths: Record<string, unknown> }>(
      await h.request("/openapi.json"),
    );
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/v1/me",
        "/v1/people",
        "/v1/people/{id}",
        "/v1/sync/token",
        "/v1/audit",
      ]),
    );
  });

  it("uses no exclusive bounds, which the breaking-change check (oasdiff) cannot read", async () => {
    const text = await (await h.request("/openapi.json")).text();
    // OpenAPI 3.1 writes them as numbers; use `.min(1)` rather than `.positive()` on whole numbers.
    expect(text).not.toMatch(/"exclusive(Minimum|Maximum)"/);
  });

  it("answers unknown routes with problem details", async () => {
    const response = await h.request("/nope");
    expect(response.status).toBe(404);
    expect((await json<ProblemDetails>(response)).code).toBe("not_found");
  });
});

describe("authentication", () => {
  it("rejects requests without a session", async () => {
    const response = await h.request("/v1/me", { tenant: DEMO.tenantId });
    expect(response.status).toBe(401);
    expect((await json<ProblemDetails>(response)).code).toBe("unauthenticated");
  });

  it("refuses passwords on the deny-list (NCSC)", async () => {
    const response = await h.request("/api/auth/sign-up/email", {
      method: "POST",
      body: { email: "weak@example.invalid", password: "password1234", name: "Weak Example" },
    });
    expect(response.status).toBe(400);
  });

  it("refuses passwords shorter than 12 characters", async () => {
    const response = await h.request("/api/auth/sign-up/email", {
      method: "POST",
      body: { email: "short@example.invalid", password: "short pass", name: "Short Example" },
    });
    expect(response.status).toBe(400);
  });
});

describe("session tokens stay out of browsers (ASVS V7)", () => {
  const credentials = { email: "nurse@example.invalid", password: PASSWORD };

  it("gives a bearer token only to the mobile app's origin", async () => {
    const mobile = await h.request("/api/auth/sign-in/email", {
      method: "POST",
      body: credentials,
      origin: MOBILE_APP_ORIGIN,
    });
    expect(mobile.status).toBe(200);
    expect(mobile.headers.get("set-auth-token")).toBeTruthy();
    expect((await json<{ token?: string }>(mobile)).token).toBeTruthy();
  });

  it.each([
    ["a web origin", "http://localhost:3000"],
    ["no origin (a server)", undefined],
  ])("returns no token to %s, only the session cookie", async (_label, origin) => {
    const response = await h.request("/api/auth/sign-in/email", {
      method: "POST",
      body: credentials,
      ...(origin ? { origin } : {}),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-auth-token")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("harbour.session_token");
    const body = await json<Record<string, unknown>>(response);
    expect(body).not.toHaveProperty("token");
    expect(body).toHaveProperty("user");
  });

  it("removes tokens from Better Auth's session list", async () => {
    const response = await h.request("/api/auth/list-sessions", { token: h.tokens.nurse });
    expect(response.status).toBe(200);
    const sessions = await json<Record<string, unknown>[]>(response);
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) expect(session).not.toHaveProperty("token");
  });
});

describe("signed-in devices (/v1/me/sessions)", () => {
  // The nurse has no second factor in the harness, so a password sign-in completes.
  async function mobileSignIn(email: string): Promise<string> {
    const response = await h.request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: PASSWORD },
      origin: MOBILE_APP_ORIGIN,
    });
    const token = response.headers.get("set-auth-token");
    if (!token) throw new Error("no token");
    return token;
  }

  it("lists your own devices without tokens and marks this one", async () => {
    const response = await h.request("/v1/me/sessions", { token: h.tokens.carer });
    expect(response.status).toBe(200);
    const { items } = await json<DeviceSessionList>(response);
    expect(items.filter((s) => s.current)).toHaveLength(1);
    for (const item of items) expect(item).not.toHaveProperty("token");
  });

  it("needs a session", async () => {
    expect((await h.request("/v1/me/sessions")).status).toBe(401);
  });

  it("signs out another of your devices, which then stops working", async () => {
    const second = await mobileSignIn("nurse@example.invalid");
    const { items } = await json<DeviceSessionList>(
      await h.request("/v1/me/sessions", { token: second }),
    );
    const secondId = items.find((s) => s.current)?.id;
    expect(secondId).toBeDefined();

    const revoked = await h.request(`/v1/me/sessions/${secondId}/revoke`, {
      method: "POST",
      token: h.tokens.nurse,
    });
    expect(revoked.status).toBe(204);
    expect((await h.request("/v1/me/sessions", { token: second })).status).toBe(401);
    expect((await h.request("/v1/me/sessions", { token: h.tokens.nurse })).status).toBe(200);
  });

  it("cannot sign out someone else's device", async () => {
    const { items } = await json<DeviceSessionList>(
      await h.request("/v1/me/sessions", { token: h.tokens.manager }),
    );
    const managerSession = items.find((s) => s.current)?.id;
    const response = await h.request(`/v1/me/sessions/${managerSession}/revoke`, {
      method: "POST",
      token: h.tokens.nurse,
    });
    expect(response.status).toBe(404);
    expect((await h.request("/v1/me/sessions", { token: h.tokens.manager })).status).toBe(200);
  });

  it("signs out every other device and keeps this one", async () => {
    const extra = await mobileSignIn("nurse@example.invalid");
    const response = await h.request("/v1/me/sessions/revoke-others", {
      method: "POST",
      token: h.tokens.nurse,
    });
    expect(response.status).toBe(200);
    expect((await json<{ revoked: number }>(response)).revoked).toBeGreaterThanOrEqual(1);
    expect((await h.request("/v1/me/sessions", { token: extra })).status).toBe(401);
    const { items } = await json<DeviceSessionList>(
      await h.request("/v1/me/sessions", { token: h.tokens.nurse }),
    );
    expect(items).toHaveLength(1);
  });
});

describe("hazard HZ-011 tenancy at the API (section 5.3)", () => {
  it("lists every organisation an agency worker belongs to", async () => {
    const response = await h.request("/v1/memberships", { token: h.tokens.agency });
    const body = await json<{ items: { tenantId: string }[] }>(response);
    expect(body.items.map((m) => m.tenantId).sort()).toEqual(
      [DEMO.tenantId, OTHER.tenantId].sort(),
    );
  });

  it("asks someone in two organisations to choose one", async () => {
    const response = await h.request("/v1/me", { token: h.tokens.agency });
    expect(response.status).toBe(400);
    expect((await json<ProblemDetails>(response)).code).toBe("tenant_required");
  });

  it("refuses an organisation the user does not belong to", async () => {
    const response = await h.request("/v1/people", {
      token: h.tokens.manager,
      tenant: OTHER.tenantId,
    });
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("not_a_member");
  });

  it("returns not found for another tenant's person, even by id", async () => {
    const response = await demo("manager", `/v1/people/${OTHER.personId}`);
    expect(response.status).toBe(404);
  });

  it("never lists another tenant's people", async () => {
    const people = await json<PersonList>(await demo("owner", "/v1/people"));
    expect(people.items.map((p) => p.id)).not.toContain(OTHER.personId);
    const theirs = await json<PersonList>(
      await h.request("/v1/people", { token: h.tokens.rae, tenant: OTHER.tenantId }),
    );
    expect(theirs.items.map((p) => p.familyName)).toEqual(["Elsewhere"]);
  });
});

describe("/v1/me", () => {
  it("describes the manager's access", async () => {
    const me = await json<Me>(await demo("manager", "/v1/me"));
    expect(me.tenant.name).toBe("Harbour Demo Care");
    expect(me.scope).toBe("locations");
    expect(me.roleKeys).toEqual(["registered_manager"]);
    expect(me.locations.map((l) => l.name)).toEqual(["Harbour House"]);
    expect(me.permissions).toContain("safety.notification.submit");
    expect(me.flags["module.ai"]).toBe(false);
  });

  it("gives the owner every location", async () => {
    const me = await json<Me>(await demo("owner", "/v1/me"));
    expect(me.scope).toBe("tenant");
    expect(me.locations.map((l) => l.name).sort()).toEqual(["Harbour House", "Harbour Lodge"]);
  });
});

describe("hazard HZ-011 people scope", () => {
  it("shows a care worker only their assigned people, with allergy details", async () => {
    const people = await json<PersonList>(await demo("carer", "/v1/people"));
    expect(people.items.map((p) => p.givenName).sort()).toEqual(["Ada", "Ben", "Cara"]);
    const ada = people.items.find((p) => p.givenName === "Ada");
    expect(ada?.allergies).toEqual([
      { substance: "Penicillin", severity: "severe", reaction: "Rash and swelling" },
    ]);
    expect(people.items.find((p) => p.givenName === "Cara")?.allergyStatus).toBe("unknown");
  });

  it("tells browsers and devices never to cache personal data", async () => {
    const response = await demo("carer", "/v1/people");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("hides people outside a care worker's assignments", async () => {
    const all = await json<PersonList>(await demo("owner", "/v1/people"));
    const elsie = all.items.find((p) => p.givenName === "Elsie");
    expect(elsie).toBeDefined();
    expect((await demo("carer", `/v1/people/${elsie?.id}`)).status).toBe(404);
  });

  it("keeps the Registered Manager to their own location", async () => {
    const people = await json<PersonList>(await demo("manager", "/v1/people"));
    expect(people.items).toHaveLength(6);
    expect(people.items.map((p) => p.id)).not.toContain(LODGE.personId);
  });

  it("blocks care records until MFA is set up", async () => {
    const response = await demo("nurse", "/v1/people");
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("mfa_enrolment_required");
  });

  it("records every view in the audit trail", async () => {
    const list = await json<PersonList>(await demo("manager", "/v1/people"));
    const ada = list.items.find((p) => p.givenName === "Ada");
    await demo("manager", `/v1/people/${ada?.id}`);
    const audit = await json<AuditList>(
      await demo("manager", `/v1/audit?resourceType=person&resourceId=${ada?.id}`),
    );
    expect(audit.items[0]).toMatchObject({ action: "people.person.view", outcome: "success" });
    expect(audit.chainIntact).toBe(true);
  });

  it("shows the version history after a change", async () => {
    const list = await json<PersonList>(await demo("manager", "/v1/people"));
    const ben = list.items.find((p) => p.givenName === "Ben");
    const history = await demo("manager", `/v1/people/${ben?.id}/history`);
    expect(history.status).toBe(200);
    expect((await json<{ versions: unknown[] }>(history)).versions).toEqual([]);
  });
});

describe("hazard HZ-011 break-glass access", () => {
  it("is refused for roles without the permission, and the refusal is audited", async () => {
    const response = await demo("carer", "/v1/people/break-glass", {
      method: "POST",
      body: {
        personId: LODGE.personId,
        justification: "Covering an emergency at the lodge tonight",
      },
    });
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("missing_permission");
  });

  it("needs a meaningful reason", async () => {
    const response = await demo("manager", "/v1/people/break-glass", {
      method: "POST",
      body: { personId: LODGE.personId, justification: "need it" },
    });
    expect(response.status).toBe(422);
  });

  it("needs a fresh sign-in (step-up)", async () => {
    await h.db
      .pool("harbour_auth")
      .query("UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE token = $1", [
        // The bearer value is the session token plus a signature.
        h.tokens.owner?.split(".")[0],
      ]);
    const response = await demo("owner", "/v1/people/break-glass", {
      method: "POST",
      body: {
        personId: LODGE.personId,
        justification: "Covering an emergency at the lodge tonight",
      },
    });
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("step_up_required");
  });

  it("opens the record, alerts the quality lead and audits the reason", async () => {
    expect((await demo("manager", `/v1/people/${LODGE.personId}`)).status).toBe(404);
    const response = await demo("manager", "/v1/people/break-glass", {
      method: "POST",
      body: {
        personId: LODGE.personId,
        justification: "Covering an emergency at the lodge tonight",
      },
    });
    expect(response.status).toBe(201);
    expect((await demo("manager", `/v1/people/${LODGE.personId}`)).status).toBe(200);

    const inbox = await json<NotificationList>(await demo("quality", "/v1/notifications"));
    const alert = inbox.items.find((n) => n.kind === "people.break_glass_opened");
    expect(alert).toBeDefined();
    expect(alert?.body).not.toContain("Gwen");

    // Only the recipient may acknowledge it.
    expect(
      (await demo("manager", `/v1/notifications/${alert?.id}/acknowledge`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await demo("quality", `/v1/notifications/${alert?.id}/acknowledge`, { method: "POST" }))
        .status,
    ).toBe(204);

    const audit = await json<AuditList>(
      await demo("manager", `/v1/audit?resourceType=person&resourceId=${LODGE.personId}`),
    );
    expect(audit.items.map((e) => e.action)).toContain("people.person.break_glass");
    expect(audit.items.find((e) => e.action === "people.person.break_glass")?.reason).toContain(
      "emergency",
    );
  });

  it("returns not found for a person who does not exist", async () => {
    const response = await demo("manager", "/v1/people/break-glass", {
      method: "POST",
      body: {
        personId: "0194d000-0000-7000-8000-00000000ffff",
        justification: "Covering an emergency at the lodge tonight",
      },
    });
    expect(response.status).toBe(404);
  });
});

describe("audit trail access", () => {
  it("is limited to roles holding platform.audit.read", async () => {
    expect((await demo("carer", "/v1/audit")).status).toBe(403);
  });
});

describe("offline sync", () => {
  it("issues a care worker a token for assigned people only", async () => {
    const response = await demo("carer", "/v1/sync/token", { method: "POST" });
    expect(response.status).toBe(200);
    const { token } = await json<SyncToken>(response);
    const { payload } = await jwtVerify(token, h.handle.signer.verificationKey, {
      audience: SYNC_TOKEN_AUDIENCE,
      issuer: SYNC_TOKEN_ISSUER,
    });
    expect(payload).toMatchObject({
      sub: DEMO.users.carer.id,
      tenant_id: DEMO.tenantId,
      location_ids: [DEMO.locationId],
      people_location_ids: [],
    });
  });

  it("hazard HZ-028 puts the tenant's offline window from the rate table in the token", async () => {
    const rate = await json<RateValue>(await demo("carer", "/v1/rates/mobile.offline_window_days"));
    const { token } = await json<SyncToken>(
      await demo("carer", "/v1/sync/token", { method: "POST" }),
    );
    const { payload } = await jwtVerify(token, h.handle.signer.verificationKey);
    expect(payload.offline_days).toEqual(offlineWindowDays(new Date(), Number(rate.value)));
  });

  it("does not let a script with a normal session widen the offline window", async () => {
    const everyDay = Array.from({ length: 400 }, (_, i) =>
      new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    );
    const response = await h.request(
      `/v1/sync/token?offline_days=${everyDay.join(",")}&offline_window_days=400`,
      {
        token: h.tokens.carer,
        tenant: DEMO.tenantId,
        method: "POST",
        body: {
          offline_days: everyDay,
          offline_window_days: 400,
          params: { offline_days: everyDay },
        },
      },
    );
    expect(response.status).toBe(200);
    const { token } = await json<SyncToken>(response);
    const { payload } = await jwtVerify(token, h.handle.signer.verificationKey);
    const rate = await json<RateValue>(await demo("carer", "/v1/rates/mobile.offline_window_days"));
    expect(payload.offline_days).toEqual(offlineWindowDays(new Date(), Number(rate.value)));
    expect((payload.offline_days as string[]).length).toBe(Number(rate.value) + 1);
  });

  it("issues a manager a token for their location's people", async () => {
    const { token } = await json<SyncToken>(
      await demo("manager", "/v1/sync/token", { method: "POST" }),
    );
    const { payload } = await jwtVerify(token, h.handle.signer.verificationKey);
    expect(payload.people_location_ids).toEqual([DEMO.locationId]);
  });

  it("hazard HZ-028 issues the fail-safe window when the tenant's rate is out of range (L3)", async () => {
    await asTenant(
      OTHER.tenantId,
      `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
       VALUES ($1, 'mobile.offline_window_days', 99, 'days', 'all', '2000-01-01', 'test', 'verified')`,
      [OTHER.tenantId],
    );
    const response = await h.request("/v1/sync/token", {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
      method: "POST",
    });
    expect(response.status).toBe(200);
    const { token } = await json<SyncToken>(response);
    const { payload } = await jwtVerify(token, h.handle.signer.verificationKey);
    expect(payload.offline_days).toEqual(offlineWindowDays(new Date(), 1));
  });

  describe("hazard HZ-040 device discards (POST /v1/sync/discards)", () => {
    const DEVICE = "0199d000-0000-4000-8000-00000000de01";
    const discard = (
      overrides: Record<string, unknown> = {},
    ): { id: string } & Record<string, unknown> => ({
      id: crypto.randomUUID(),
      kind: "refused_removed",
      stage: "requested",
      reasonCode: "recorded_elsewhere",
      ownerTenantUserId: DEMO.users.carer.id,
      deletedByTenantUserId: DEMO.users.carer.id,
      entryIds: [crypto.randomUUID()],
      personIds: [crypto.randomUUID()],
      count: 1,
      discardedAt: new Date().toISOString(),
      ...overrides,
    });
    const post = (
      token: string | undefined,
      body: unknown,
      tenant: string = DEMO.tenantId,
      device?: string,
    ) =>
      h.handle.app.request("/v1/sync/discards", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          [TENANT_HEADER]: tenant,
          ...(device ? { [DEVICE_HEADER]: device } : {}),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    type AuditRow = {
      id: string;
      tenant_id: string;
      action: string;
      actor_tenant_user_id: string;
      reason: string | null;
      device_id: string | null;
      scope: Record<string, unknown>;
    };
    const auditRows = (id: string, tenantId: string = DEMO.tenantId) =>
      asTenant<AuditRow>(
        tenantId,
        "SELECT id, tenant_id, action, actor_tenant_user_id, reason, device_id, scope FROM audit_event WHERE resource_id = $1 ORDER BY seq",
        [id],
      );

    it("records who deleted what, whose, the coded reason, how many and from which device", async () => {
      const body = discard();
      const response = await post(h.tokens.carer, body, DEMO.tenantId, DEVICE);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: body.id, recorded: true, replay: false });
      const [row, ...more] = await auditRows(body.id);
      expect(more).toEqual([]);
      expect(row).toMatchObject({
        tenant_id: DEMO.tenantId,
        action: "sync.entries.discard_requested",
        actor_tenant_user_id: DEMO.users.carer.id,
        reason: "recorded_elsewhere",
        device_id: DEVICE,
      });
      expect(row?.scope).toMatchObject({
        kind: "refused_removed",
        stage: "requested",
        reasonCode: "recorded_elsewhere",
        ownerTenantUserId: DEMO.users.carer.id,
        deletedByTenantUserId: DEMO.users.carer.id,
        entryIds: body.entryIds,
        personIds: body.personIds,
        count: 1,
      });
    });

    it("keeps the person's words out of the hash-chained audit trail (round 4, M3; round 5, S-L6)", async () => {
      // Words sent anyway are refused, not quietly dropped: nothing is recorded.
      const body = discard({ reasonCode: "other", reason: "Recorded on paper for Ada Example" });
      expect((await post(h.tokens.carer, body)).status).toBe(422);
      expect(await auditRows(body.id)).toEqual([]);
      const coded = discard({ reasonCode: "other" });
      expect((await post(h.tokens.carer, coded)).status).toBe(200);
      const [row] = await auditRows(coded.id);
      expect(row?.reason).toBe("other");
    });

    it("records each stage of a deletion once, and a failure supersedes the request (round 4, H1)", async () => {
      const requested = discard({ kind: "held_deleted" });
      expect((await post(h.tokens.carer, requested)).status).toBe(200);
      const again = await post(h.tokens.carer, requested);
      expect(await again.json()).toEqual({ id: requested.id, recorded: true, replay: true });
      const failed = { ...requested, stage: "failed" };
      expect((await post(h.tokens.carer, failed)).status).toBe(200);
      expect((await post(h.tokens.carer, failed)).status).toBe(200);
      const rows = await auditRows(requested.id);
      expect(rows.map((r) => r.action)).toEqual([
        "sync.entries.discard_requested",
        "sync.entries.discard_failed",
      ]);
      expect(rows[1]?.scope).toMatchObject({ supersedesAuditEventId: rows[0]?.id });
      const deleted = discard({ kind: "held_deleted" });
      await post(h.tokens.carer, deleted);
      await post(h.tokens.carer, { ...deleted, stage: "deleted" });
      expect((await auditRows(deleted.id)).map((r) => r.action)).toEqual([
        "sync.entries.discard_requested",
        "sync.entries.discarded",
      ]);
    });

    it("records two racing copies of the same stage once", async () => {
      const body = discard();
      const results = await Promise.all([post(h.tokens.carer, body), post(h.tokens.carer, body)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await auditRows(body.id)).toHaveLength(1);
    });

    it("needs a manager to delete another member of staff's entries", async () => {
      const someoneElse = discard({
        kind: "held_deleted",
        ownerTenantUserId: DEMO.users.nurse.id,
        deletedByTenantUserId: DEMO.users.manager.id,
      });
      expect((await post(h.tokens.carer, someoneElse)).status).toBe(403);
      expect(await auditRows(someoneElse.id)).toEqual([]);
      const byManager = await post(h.tokens.manager, someoneElse);
      expect(byManager.status).toBe(200);
      const [row] = await auditRows(someoneElse.id);
      expect(row?.actor_tenant_user_id).toBe(DEMO.users.manager.id);
      expect(row?.scope).toMatchObject({ deletedByTenantUserId: DEMO.users.manager.id });
    });

    it.each([
      [
        "a deleter who is not the caller (forged)",
        { deletedByTenantUserId: DEMO.users.manager.id },
      ],
      ["an unknown owner", { ownerTenantUserId: null }],
    ])("needs a manager for %s (round 4, M1)", async (_case, change) => {
      const body = discard({ kind: "held_deleted", ...change });
      expect((await post(h.tokens.carer, body)).status).toBe(403);
      expect(await auditRows(body.id)).toEqual([]);
      // A manager holds the permission (as do the deputy and the nurse in charge, by role).
      expect((await post(h.tokens.manager, body)).status).toBe(200);
    });

    it("refuses an owner or deleter who is not staff of this organisation (round 4, M1)", async () => {
      const stranger = crypto.randomUUID();
      for (const change of [{ ownerTenantUserId: stranger }, { deletedByTenantUserId: stranger }]) {
        const body = discard({ kind: "held_deleted", ...change });
        expect((await post(h.tokens.manager, body)).status).toBe(422);
        expect(await auditRows(body.id)).toEqual([]);
      }
    });

    it("records an unknown deleter as unknown, never as the sender (round 5, S-L2)", async () => {
      const body = discard({
        kind: "held_deleted",
        ownerTenantUserId: DEMO.users.nurse.id,
        deletedByTenantUserId: undefined,
      });
      expect((await post(h.tokens.manager, body)).status).toBe(200);
      const [row] = await auditRows(body.id);
      expect(row?.actor_tenant_user_id).toBe(DEMO.users.manager.id);
      expect(row?.scope).toMatchObject({ deletedByTenantUserId: null });
    });

    it("ties a later stage to the deletion it continues: same kind and owner (round 5, S-L1)", async () => {
      const body = discard({ kind: "held_deleted" });
      expect((await post(h.tokens.carer, body)).status).toBe(200);
      const otherKind = { ...body, stage: "deleted", kind: "signed_out_with_unsent" };
      expect((await post(h.tokens.carer, otherKind)).status).toBe(422);
      const otherOwner = { ...body, stage: "deleted", ownerTenantUserId: DEMO.users.nurse.id };
      expect((await post(h.tokens.manager, otherOwner)).status).toBe(422);
      expect((await auditRows(body.id)).map((r) => r.action)).toEqual([
        "sync.entries.discard_requested",
      ]);
      // A manager may record the outcome of a carer's own deletion.
      expect((await post(h.tokens.manager, { ...body, stage: "deleted" })).status).toBe(200);
    });

    it("records what a deletion left on the device as a security event, and why it has no ids (round 5, C-M1 and C-M2)", async () => {
      const body = discard({
        kind: "held_deleted",
        entryIds: [],
        personIds: [],
        count: null,
        idsMissing: "key_invalid",
      });
      await post(h.tokens.carer, body);
      expect(
        (await post(h.tokens.carer, { ...body, stage: "deleted", leftover: ["file"] })).status,
      ).toBe(200);
      const rows = await auditRows(body.id);
      expect(rows.map((r) => r.action)).toEqual([
        "sync.entries.discard_requested",
        "sync.entries.discarded",
        "sync.device.residue",
      ]);
      expect(rows[0]?.scope).toMatchObject({ idsMissing: "key_invalid" });
      expect(rows[2]?.scope).toEqual({ leftover: ["file"] });
    });

    it("hazard HZ-040 closes the device's hold task when its held entries are recorded deleted (round 5, C-M3)", async () => {
      const device = "0199d000-0000-4000-8000-00000000de08";
      const reportFrom = (token: string | undefined, held: number) =>
        h.handle.app.request("/v1/sync/device-report", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            [TENANT_HEADER]: DEMO.tenantId,
            [DEVICE_HEADER]: device,
          },
          body: JSON.stringify({
            unsent: 0,
            refused: 0,
            held,
            blocked: 0,
            oldestAgeSeconds: null,
            reportedAt: new Date().toISOString(),
          }),
        });
      expect((await reportFrom(h.tokens.carer, 2)).status).toBe(204);
      const status = async () =>
        (
          await asTenant<{ status: string }>(
            DEMO.tenantId,
            "SELECT status FROM task WHERE source_type = 'device_hold' AND source_id = $1",
            [device],
          )
        ).map((r) => r.status);
      expect(await status()).toEqual(["open"]);
      // The Registered Manager deletes the held entries on that device: requested, then deleted.
      const body = discard({
        kind: "held_deleted",
        ownerTenantUserId: DEMO.users.carer.id,
        deletedByTenantUserId: DEMO.users.manager.id,
      });
      await post(h.tokens.manager, body, DEMO.tenantId, device);
      expect(await status()).toEqual(["open"]);
      await post(h.tokens.manager, { ...body, stage: "deleted" }, DEMO.tenantId, device);
      expect(await status()).toEqual(["done"]);
    });

    it("counts each person's entry ids a day (round 5, S-M2)", async () => {
      const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
      const big = () =>
        discard({
          ownerTenantUserId: DEMO.users.owner.id,
          deletedByTenantUserId: DEMO.users.owner.id,
          entryIds: ids(500),
          personIds: [],
          count: 500,
        });
      for (let i = 0; i < 4; i += 1) expect((await post(h.tokens.owner, big())).status).toBe(200);
      const over = big();
      const refused = await post(h.tokens.owner, over);
      expect(refused.status).toBe(429);
      expect(await auditRows(over.id)).toEqual([]);
    });

    it("keeps the event in the caller's tenant only (HZ-011)", async () => {
      const body = discard();
      // The carer is not a member of the other tenant.
      expect((await post(h.tokens.carer, body, OTHER.tenantId)).status).toBe(403);
      expect(await auditRows(body.id)).toEqual([]);
      expect((await post(h.tokens.carer, body)).status).toBe(200);
      const rows = await auditRows(body.id);
      expect(rows.map((r) => r.tenant_id)).toEqual([DEMO.tenantId]);
      expect(await auditRows(body.id, OTHER.tenantId)).toEqual([]);
      // The other tenant's manager does not see it in their audit trail.
      const theirs = await json<AuditList>(
        await h.request(`/v1/audit?resourceType=device_discard&resourceId=${body.id}`, {
          token: h.tokens.rae,
          tenant: OTHER.tenantId,
        }),
      );
      expect(theirs.items).toEqual([]);
    });

    it("refuses an unknown reason code, more ids than entries, and a body over 64 KB (round 4, M4)", async () => {
      expect((await post(h.tokens.carer, discard({ reasonCode: "because" }))).status).toBe(422);
      const twoIds = [crypto.randomUUID(), crypto.randomUUID()];
      expect((await post(h.tokens.carer, discard({ entryIds: twoIds, count: 1 }))).status).toBe(
        422,
      );
      const huge = JSON.stringify({ ...discard(), padding: "x".repeat(70 * 1024) });
      expect((await post(h.tokens.carer, huge)).status).toBe(413);
    });

    it("takes no device id that is not a UUID into the audit trail", async () => {
      const body = discard();
      expect((await post(h.tokens.carer, body, DEMO.tenantId, "device-fixture-1")).status).toBe(
        200,
      );
      const [row] = await auditRows(body.id);
      expect(row?.device_id).toBeNull();
    });
  });

  describe("hazard HZ-006 device reports (POST /v1/sync/device-report)", () => {
    const DEVICE = "0199d000-0000-4000-8000-00000000de02";
    const DAY = 86_400_000;
    const report = (token: string | undefined, body: Record<string, unknown>, device?: string) =>
      h.handle.app.request("/v1/sync/device-report", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          [TENANT_HEADER]: DEMO.tenantId,
          ...(device ? { [DEVICE_HEADER]: device } : {}),
        },
        body: JSON.stringify({
          unsent: 0,
          refused: 0,
          held: 0,
          blocked: 0,
          oldestAgeSeconds: null,
          reportedAt: new Date().toISOString(),
          ...body,
        }),
      });
    type TaskRow = {
      id: string;
      status: string;
      due_at: Date;
      location_id: string | null;
      assignee_tenant_user_id: string | null;
      assignee_role_key: string | null;
      required_permission: string;
      title: string;
      person_id: string | null;
      created_by: string | null;
      updated_by: string | null;
    };
    const deviceTasks = (device: string) =>
      asTenant<TaskRow>(
        DEMO.tenantId,
        "SELECT id, status, due_at, location_id, assignee_tenant_user_id, assignee_role_key, required_permission, title, person_id, created_by, updated_by FROM task WHERE source_type = 'device_hold' AND source_id = $1 ORDER BY created_at",
        [device],
      );
    const holdAudit = (device: string) =>
      asTenant<{ action: string; outcome: string; resource_id: string | null }>(
        DEMO.tenantId,
        "SELECT action, outcome, resource_id FROM audit_event WHERE action LIKE 'sync.device_hold.%' AND scope ->> 'deviceId' = $1 ORDER BY seq",
        [device],
      );
    /** The tasks a member can read through the API, over the next month. */
    const visibleTo = async (token: keyof Harness["tokens"]) => {
      const from = new Date(Date.now() - DAY).toISOString();
      const to = new Date(Date.now() + 29 * DAY).toISOString();
      const list = await json<TaskList>(
        await demo(
          token,
          `/v1/tasks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        ),
      );
      return list.items.map((t) => t.id);
    };

    it("hazard HZ-006 records a device's unsent counts without personal data", async () => {
      const response = await report(
        h.tokens.carer,
        { unsent: 3, refused: 1, held: 0, oldestAgeSeconds: 5400 },
        "0199d000-0000-4000-8000-00000000de03",
      );
      expect(response.status).toBe(204);
      const rows = await asTenant<{ scope: Record<string, unknown> }>(
        DEMO.tenantId,
        "SELECT scope FROM audit_event WHERE action = 'sync.device.report' AND device_id = '0199d000-0000-4000-8000-00000000de03'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.scope).toEqual({
        unsent: 3,
        refused: 1,
        held: 0,
        blocked: 0,
        oldestAgeSeconds: 5400,
        heldSince: null,
        reportedAt: expect.any(String),
        deviceClockAhead: false,
      });
    });

    it("hazard HZ-040 raises one task for the Registered Manager at the reporter's location, due when the hold escalates, never moved later, and closed at zero (round 5, C-H1 and S-M1)", async () => {
      const heldSince = new Date(Date.now() - 2 * DAY);
      expect(
        (await report(h.tokens.carer, { held: 2, heldSince: heldSince.toISOString() }, DEVICE))
          .status,
      ).toBe(204);
      let tasks = await deviceTasks(DEVICE);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        status: "open",
        location_id: DEMO.locationId,
        assignee_tenant_user_id: null,
        assignee_role_key: "registered_manager",
        required_permission: "safety.incident.manage",
        title: "Unsent care entries are waiting on a device",
        person_id: null,
        // Written as the reporter, not as nobody (S-M1).
        created_by: DEMO.users.carer.id,
      });
      // Due at the hold's start plus mobile.held_entries_max_days (7 by default).
      const due = heldSince.getTime() + 7 * DAY;
      expect(new Date(tasks[0]?.due_at ?? 0).getTime()).toBe(due);
      // The location's Registered Manager, whose role is scoped to the location, can read it.
      expect(await visibleTo("manager")).toContain(tasks[0]?.id);
      // A later start never moves the due time later; an earlier one brings it forward.
      await report(
        h.tokens.carer,
        { held: 3, heldSince: new Date(heldSince.getTime() + DAY).toISOString() },
        DEVICE,
      );
      expect(new Date((await deviceTasks(DEVICE))[0]?.due_at ?? 0).getTime()).toBe(due);
      const earlier = new Date(heldSince.getTime() - 3_600_000);
      await report(h.tokens.carer, { held: 3, heldSince: earlier.toISOString() }, DEVICE);
      tasks = await deviceTasks(DEVICE);
      expect(tasks).toHaveLength(1);
      expect(new Date(tasks[0]?.due_at ?? 0).getTime()).toBe(earlier.getTime() + 7 * DAY);
      // Entries a failed deletion left behind keep it open (C-M3).
      await report(h.tokens.carer, { blocked: 1 }, DEVICE);
      expect((await deviceTasks(DEVICE)).map((t) => t.status)).toEqual(["open"]);
      // Nothing waiting, from the reporter who raised it: the task closes.
      await report(h.tokens.carer, {}, DEVICE);
      tasks = await deviceTasks(DEVICE);
      expect(tasks.map((t) => t.status)).toEqual(["done"]);
      expect(tasks[0]?.updated_by).toBe(DEMO.users.carer.id);
      // Every raise, move and close is audited, with the task's opaque id.
      expect((await holdAudit(DEVICE)).map((r) => [r.action, r.resource_id])).toEqual([
        ["sync.device_hold.raised", tasks[0]?.id],
        ["sync.device_hold.moved", tasks[0]?.id],
        ["sync.device_hold.closed", tasks[0]?.id],
      ]);
    });

    it("hazard HZ-040 another member can neither close nor postpone a known device's task (round 5, S-M1)", async () => {
      const device = "0199d000-0000-4000-8000-00000000de05";
      const heldSince = new Date(Date.now() - DAY);
      await report(h.tokens.carer, { held: 1, heldSince: heldSince.toISOString() }, device);
      const [raised] = await deviceTasks(device);
      // The agency worker is a member with no role: no permission to act on the task.
      expect((await report(h.tokens.agency, {}, device)).status).toBe(204);
      await report(h.tokens.agency, { held: 1, heldSince: new Date().toISOString() }, device);
      const [after] = await deviceTasks(device);
      expect(after).toMatchObject({ id: raised?.id, status: "open" });
      expect(after?.due_at).toEqual(raised?.due_at);
      expect((await holdAudit(device)).map((r) => [r.action, r.outcome])).toContainEqual([
        "sync.device_hold.close_refused",
        "denied",
      ]);
      // Someone who can act on it (a Registered Manager) may close it with a report.
      await report(h.tokens.manager, {}, device);
      expect((await deviceTasks(device)).map((t) => t.status)).toEqual(["done"]);
    });

    it("hazard HZ-010 takes a hold's start no later than the server received the report (round 5, S-M1)", async () => {
      const device = "0199d000-0000-4000-8000-00000000de06";
      const future = new Date(Date.now() + 10 * DAY).toISOString();
      const before = Date.now();
      await report(h.tokens.carer, { held: 1, heldSince: future, reportedAt: future }, device);
      const [raised] = await deviceTasks(device);
      expect(new Date(raised?.due_at ?? 0).getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY);
      expect(new Date(raised?.due_at ?? 0).getTime()).toBeGreaterThanOrEqual(before + 7 * DAY);
      const [audited] = await asTenant<{ scope: Record<string, unknown> }>(
        DEMO.tenantId,
        "SELECT scope FROM audit_event WHERE action = 'sync.device.report' AND device_id = $1",
        [device],
      );
      expect(audited?.scope).toMatchObject({ deviceClockAhead: true });
      expect(Date.parse(String(audited?.scope.heldSince))).toBeLessThanOrEqual(Date.now());
      await report(h.tokens.carer, {}, device);
    });

    it("hazard HZ-040 gives each Registered Manager the task when the reporter's location is not known (round 5, C-H1)", async () => {
      // The agency worker is a member here with no role, so without people.person.read, and has
      // never had a role at a location.
      const device = "0199d000-0000-4000-8000-00000000de04";
      const heldSince = new Date(Date.now() - 3_600_000).toISOString();
      expect((await report(h.tokens.agency, { held: 1, heldSince }, device)).status).toBe(204);
      const tasks = await deviceTasks(device);
      expect(tasks.map((t) => [t.status, t.location_id, t.assignee_tenant_user_id])).toEqual([
        ["open", null, DEMO.users.manager.id],
      ]);
      expect(await visibleTo("manager")).toContain(tasks[0]?.id);
      // Not a member at all: refused.
      expect((await report(h.tokens.rae, { held: 1, heldSince }, device)).status).toBe(403);
      await report(h.tokens.manager, {}, device);
    });

    it("hazard HZ-040 finds the location of an agency worker whose role ended with the shift (round 5, C-H1)", async () => {
      // The agency worker's role at the home was removed at the end of the shift plus 2 hours.
      await asTenant(
        DEMO.tenantId,
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason, deleted_at)
         SELECT tu.id, r.id, $1, 'Agency shift', now()
         FROM tenant_user tu, role r
         WHERE tu.email = 'agency@example.invalid' AND tu.tenant_id = $2
           AND r.key = 'agency_worker' AND r.tenant_id = $2`,
        [DEMO.locationId, DEMO.tenantId],
      );
      const device = "0199d000-0000-4000-8000-00000000de07";
      const heldSince = new Date(Date.now() - 3_600_000).toISOString();
      expect((await report(h.tokens.agency, { held: 2, heldSince }, device)).status).toBe(204);
      const [raised] = await deviceTasks(device);
      expect(raised).toMatchObject({ location_id: DEMO.locationId, assignee_tenant_user_id: null });
      expect(await visibleTo("manager")).toContain(raised?.id);
      await report(h.tokens.manager, {}, device);
    });

    it("hazard HZ-008 opens a few devices' tasks per reporter at most (round 5, S-M1)", async () => {
      const devices = [1, 2, 3, 4].map((n) => `0199d000-0000-4000-8000-0000000d0e0${n}`);
      for (const device of devices) {
        expect((await report(h.tokens.manager, { held: 1 }, device)).status).toBe(204);
      }
      const open = await Promise.all(devices.map((d) => deviceTasks(d)));
      expect(open.map((t) => t.length)).toEqual([1, 1, 1, 0]);
      expect((await holdAudit(devices[3] ?? "")).map((r) => r.action)).toEqual([
        "sync.device_hold.capped",
      ]);
      for (const device of devices) await report(h.tokens.manager, {}, device);
    });

    it("asks for MFA where the member's roles call for it (round 5, S-M1)", async () => {
      // The nurse's roles need MFA, which this session does not have.
      expect((await report(h.tokens.nurse, { held: 1 }, DEVICE)).status).toBe(403);
    });

    it("limits each person's reports per hour (round 4, M4)", async () => {
      let last: Response | null = null;
      for (let i = 0; i < 121; i += 1) last = await report(h.tokens.owner, {});
      expect(last?.status).toBe(429);
      expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
      // Someone else is not affected.
      expect((await report(h.tokens.manager, {})).status).toBe(204);
    });
  });

  it("publishes the verification key", async () => {
    const jwks = await json<{ keys: { kid: string; alg: string }[] }>(
      await h.request("/v1/sync/jwks"),
    );
    expect(jwks.keys[0]).toMatchObject({ alg: "ES256" });
  });

  it("rejects uploads to tables that are not writable yet, with a reason", async () => {
    const response = await demo("carer", "/v1/sync/upload", {
      method: "POST",
      body: {
        operations: [{ op: "PUT", table: "person", id: "x", data: { given_name: "Changed" } }],
      },
    });
    const result = await json<SyncUploadResult>(response);
    expect(result).toEqual({
      applied: 0,
      rejected: [{ id: "x", code: "table_not_writable", message: expect.any(String) }],
    });
  });
});

describe("statutory figures", () => {
  it("reads rates from the rate table, never from code", async () => {
    const rate = await json<RateValue>(
      await demo("carer", "/v1/rates/nmw.hourly.21_plus?on=2026-10-11"),
    );
    expect(rate).toMatchObject({ value: 12.71, unit: "GBP_per_hour", verified: true });
  });

  it("returns not found when no figure is in force", async () => {
    expect((await demo("carer", "/v1/rates/nmw.hourly.21_plus?on=1990-01-01")).status).toBe(404);
  });
});
