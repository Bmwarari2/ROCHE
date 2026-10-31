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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTH_MAX_BODY_BYTES } from "../src/app";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import type { TenantAccess } from "../src/http/context";
import { recordDeviceHold } from "../src/services/device-holds";
import { auditRowsFor, postSized } from "./support/body-size";
import { ageSession, createHarness, type Harness, LODGE, OTHER, PASSWORD } from "./support/harness";

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

  it("never offers a one-time code by SMS or email as a second factor (section 5.3)", async () => {
    // Passkeys and authenticator apps only; SMS is a documented exception that is not configured.
    const response = await h.request("/api/auth/two-factor/send-otp", {
      method: "POST",
      token: h.tokens.nurse,
      body: {},
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code?: string }).code).toBe("OTP_NOT_CONFIGURED");
  });

  it("refuses a sign-in route body over 64 KiB with 413 before Better Auth reads it (security review, 31 October 2026)", async () => {
    const signUp = {
      email: "capped@example.invalid",
      password: "four random harbour words",
      name: "Cap Example",
    };
    for (const declared of [false, true]) {
      const response = await postSized(
        h,
        "/api/auth/sign-up/email",
        signUp,
        AUTH_MAX_BODY_BYTES + 1,
        `cap-auth-${declared}`,
        declared,
      );
      expect(response.status).toBe(413);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({ status: 413, code: "too_large" });
    }
    const users = () =>
      h.db.pool("harbour_auth").query('SELECT 1 FROM auth."user" WHERE email = $1', [signUp.email]);
    expect((await users()).rowCount).toBe(0);
    expect(await auditRowsFor(h, ["cap-auth-false", "cap-auth-true"])).toBe(0);
    // A normal body works.
    const created = await h.request("/api/auth/sign-up/email", { method: "POST", body: signUp });
    expect(created.status).toBe(200);
    expect((await users()).rowCount).toBe(1);
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
    const body = await json<{ versions: unknown[]; latestChanged: string[] }>(history);
    expect(body.versions).toEqual([]);
    // Nothing to compare with, so no field is marked.
    expect(body.latestChanged).toEqual([]);
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
    // The bearer value is the session token plus a signature.
    await ageSession(h.db.pool("harbour_auth"), h.tokens.owner?.split(".")[0] ?? "", 3600);
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
    // The reason is for the organisation's view of the trail only (ADR-0071 review round 1, S-M3).
    expect(audit.items.find((e) => e.action === "people.person.break_glass")?.reason).toBeNull();
    const whole = await json<AuditList>(
      await demo("quality", `/v1/audit?resourceType=person&resourceId=${LODGE.personId}`),
    );
    expect(whole.items.find((e) => e.action === "people.person.break_glass")?.reason).toContain(
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

describe("request ids in the audit trail (security reviews, 31 October 2026 and #134 M4)", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const resident = "0194d000-0000-7000-8600-000000000001";
  /** Opens a care record with the request id given, and reads back what the audit row kept. */
  const viewWith = async (requestId: string) => {
    const response = await h.request(`/v1/people/${resident}`, {
      token: h.tokens.manager,
      tenant: DEMO.tenantId,
      headers: { "x-request-id": requestId },
    });
    expect(response.status).toBe(200);
    const echoed = response.headers.get("x-request-id") ?? "";
    const rows = await asTenant<{ request_id: string | null }>(
      DEMO.tenantId,
      "SELECT request_id FROM audit_event WHERE action = 'people.person.view' AND request_id = $1",
      [echoed],
    );
    const kept = await asTenant<{ n: number }>(
      DEMO.tenantId,
      "SELECT count(*)::int AS n FROM audit_event WHERE request_id = $1",
      [requestId],
    );
    return { echoed, audited: rows.map((r) => r.request_id), kept: kept[0]?.n };
  };

  it.each([
    ["a canonical UUID", "0194d000-0000-7000-8000-0000000a0001"],
    ["an id-shaped name and NHS number", "Ada-Example-9434765919"],
    ["free text with personal data", "Ada Example 9990000000 ada@example.invalid"],
    ["an id longer than 64 characters", "a".repeat(65)],
    ["markup", "<img src=x onerror=alert(1)>"],
  ])("writes the API's own id to the audit row, never %s the caller sent", async (_label, sent) => {
    const { echoed, audited, kept } = await viewWith(sent);
    expect(echoed).toMatch(UUID);
    expect(echoed).not.toBe(sent);
    expect(audited).toEqual([echoed]);
    expect(kept).toBe(0);
  });

  it("gives two requests carrying the same id two different audit ids", async () => {
    const reused = "0194d000-0000-7000-8000-0000000a0002";
    const first = await viewWith(reused);
    const second = await viewWith(reused);
    expect(first.echoed).not.toBe(second.echoed);
  });

  it("logs a caller's canonical UUID beside the API's id, and nothing else the caller sent", async () => {
    const logged = vi.spyOn(h.handle.services.logger, "info");
    try {
      const sent = "0194d000-0000-7000-8000-0000000a0003";
      const { echoed } = await viewWith(sent);
      expect(logged).toHaveBeenCalledWith(
        { requestId: echoed, callerRequestId: sent },
        "caller request id",
      );
      logged.mockClear();
      await viewWith("Ada-Example-9434765919");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("Ada-Example");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("offline sync", () => {
  // Each test starts with no sync tasks: they are retired (soft-deleted), so each reporter's day of
  // raised devices (HZ-008) starts again.
  afterEach(async () => {
    await asTenant(
      DEMO.tenantId,
      "UPDATE task SET deleted_at = now() WHERE kind LIKE 'sync.%' AND deleted_at IS NULL",
    );
  });

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
      care_location_ids: [],
      entries_location_ids: [],
      handover_location_ids: [],
      // The care worker role is scoped to assigned people and carries every synced read.
      people_assigned: true,
      care_assigned: true,
      entries_assigned: true,
      handover_assigned: true,
      // The phone may record for the people the care worker is assigned to (review round 2, C2-M3).
      entries_write_location_ids: [],
      entries_write_assigned: true,
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
    expect(payload).toMatchObject({
      people_location_ids: [DEMO.locationId],
      care_location_ids: [DEMO.locationId],
      entries_location_ids: [DEMO.locationId],
      handover_location_ids: [DEMO.locationId],
      people_assigned: false,
      care_assigned: false,
      entries_assigned: false,
      handover_assigned: false,
      entries_write_location_ids: [DEMO.locationId],
      entries_write_assigned: false,
    });
    // The shift pattern of each nation it has homes in, for the phone's handover (ADR-0074).
    const day = await json<RateValue>(
      await demo("manager", "/v1/rates/handover.day_shift_start_minute"),
    );
    const night = await json<RateValue>(
      await demo("manager", "/v1/rates/handover.night_shift_start_minute"),
    );
    expect(payload.handover_shifts).toEqual({
      england: { day: Number(day.value), night: Number(night.value) },
    });
  });

  it("hazard HZ-018 leaves out a nation whose shift figures are out of order, and tells the operator (#50 review round 1, clinical M4)", async () => {
    const insert = await asTenant<{ id: string }>(
      DEMO.tenantId,
      `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
       VALUES ($1, 'handover.night_shift_start_minute', 60, 'minutes', 'england', '2000-01-01', 'test', 'verified')
       RETURNING id`,
      [DEMO.tenantId],
    );
    const warn = vi.spyOn(h.handle.services.logger, "warn");
    try {
      const { token } = await json<SyncToken>(
        await demo("manager", "/v1/sync/token", { method: "POST" }),
      );
      const { payload } = await jwtVerify(token, h.handle.signer.verificationKey);
      // Night before day: no pattern for England, so the phone says it cannot tell.
      expect(payload.handover_shifts).toEqual({});
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: DEMO.tenantId, nations: ["england"] }),
        expect.stringMatching(/^handover shift pattern missing or out of order/),
      );
      // Opaque ids and rate keys only: no names, no figures.
      const fields = JSON.stringify(warn.mock.calls.at(-1)?.[0]);
      expect(fields).not.toMatch(/Example|@|"value"/);
    } finally {
      warn.mockRestore();
      await asTenant(DEMO.tenantId, "DELETE FROM rate_table WHERE id = $1", [insert[0]?.id]);
    }
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

    it("hazard HZ-040 closes the hold of the device a deletion names, sent from the device's next database (round 6, M1)", async () => {
      const held = "0199d000-0000-4000-8000-00000000de09";
      const next = "0199d000-0000-4000-8000-00000000de0a";
      const report = (token: string | undefined, body: Record<string, unknown>) =>
        h.handle.app.request("/v1/sync/device-report", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            [TENANT_HEADER]: DEMO.tenantId,
            [DEVICE_HEADER]: held,
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
      expect((await report(h.tokens.carer, { held: 2 })).status).toBe(204);
      const status = async () =>
        (
          await asTenant<{ status: string }>(
            DEMO.tenantId,
            "SELECT status FROM task WHERE source_type = 'device_hold' AND source_id = $1 AND deleted_at IS NULL",
            [held],
          )
        ).map((r) => r.status);
      // Someone with no right to close it names the device: refused, and audited.
      await asTenant(
        DEMO.tenantId,
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
         SELECT tu.id, r.id, $1, 'Agency shift'
         FROM tenant_user tu, role r
         WHERE tu.email = 'agency@example.invalid' AND tu.tenant_id = $2
           AND r.key = 'agency_worker' AND r.tenant_id = $2`,
        [DEMO.locationId, DEMO.tenantId],
      );
      const agencyId = (
        await asTenant<{ id: string }>(
          DEMO.tenantId,
          "SELECT id FROM tenant_user WHERE email = 'agency@example.invalid' AND tenant_id = $1",
          [DEMO.tenantId],
        )
      )[0]?.id;
      const theirs = discard({
        kind: "held_deleted",
        ownerTenantUserId: agencyId,
        deletedByTenantUserId: agencyId,
        deviceId: held,
      });
      expect((await post(h.tokens.agency, theirs, DEMO.tenantId, next)).status).toBe(200);
      expect(
        (await post(h.tokens.agency, { ...theirs, stage: "deleted" }, DEMO.tenantId, next)).status,
      ).toBe(200);
      expect(await status()).toEqual(["open"]);
      await asTenant(
        DEMO.tenantId,
        "UPDATE role_assignment SET deleted_at = now() WHERE reason = 'Agency shift' AND deleted_at IS NULL",
      );
      // The owner's own deletion, its last stage sent from the device's next database: without the
      // device it names, nothing would close.
      const unnamed = discard({ kind: "held_deleted" });
      await post(h.tokens.carer, unnamed, DEMO.tenantId, next);
      await post(h.tokens.carer, { ...unnamed, stage: "deleted" }, DEMO.tenantId, next);
      expect(await status()).toEqual(["open"]);
      const body = discard({ kind: "held_deleted", deviceId: held });
      await post(h.tokens.carer, body, DEMO.tenantId, held);
      await post(h.tokens.carer, { ...body, stage: "deleted" }, DEMO.tenantId, next);
      expect(await status()).toEqual(["done"]);
      const [deleted] = (await auditRows(body.id)).filter(
        (r) => r.action === "sync.entries.discarded",
      );
      expect(deleted).toMatchObject({ device_id: next, scope: { heldOnDeviceId: held } });
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

    it("limits each person to 20 new deletion records a day, with or without ids (round 6, M2)", async () => {
      // Records with no ids cost nothing against the id quota, so they are counted on their own.
      const noIds = () =>
        discard({
          ownerTenantUserId: DEMO.users.manager.id,
          deletedByTenantUserId: DEMO.users.manager.id,
          entryIds: [],
          personIds: [],
          count: null,
          idsMissing: "key_absent",
        });
      const accepted: Array<{ id: string }> = [];
      let refused: Response | null = null;
      for (let i = 0; i < 21 && !refused; i += 1) {
        const body = noIds();
        const response = await post(h.tokens.manager, body);
        if (response.status === 429) {
          refused = response;
          expect(await auditRows(body.id)).toEqual([]);
        } else {
          expect(response.status).toBe(200);
          accepted.push(body);
        }
      }
      expect(refused?.status).toBe(429);
      // The manager recorded a few deletions in earlier tests; the day holds 20 in all.
      expect(accepted.length).toBeGreaterThanOrEqual(15);
      expect(accepted.length).toBeLessThan(20);
      // A later stage of a record already started is not a new record.
      const started = accepted[0];
      expect((await post(h.tokens.manager, { ...started, stage: "deleted" })).status).toBe(200);
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
    /**
     * The member synced from the device some days ago: the binding a sync token writes
     * (`device_binding`). It binds them to the device (security review round 7, M1) and says when
     * the server first saw it.
     */
    const syncedOn = (device: string, tenantUserId: string, daysAgo: number) =>
      asTenant(
        DEMO.tenantId,
        `INSERT INTO device_binding (tenant_id, device_id, tenant_user_id, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, now() - make_interval(days => $4), now() - make_interval(days => $4))
         ON CONFLICT (tenant_id, device_id, tenant_user_id) DO NOTHING`,
        [DEMO.tenantId, device, tenantUserId, daysAgo],
      );
    const reportScopes = (device: string) =>
      asTenant<{ scope: Record<string, unknown> }>(
        DEMO.tenantId,
        "SELECT scope FROM audit_event WHERE action = 'sync.device.report' AND resource_type = 'device' AND resource_id = $1 ORDER BY seq",
        [device],
      ).then((rows) => rows.map((r) => r.scope));
    const raiseScopes = (device: string) =>
      asTenant<{ action: string; scope: Record<string, unknown> }>(
        DEMO.tenantId,
        "SELECT action, scope FROM audit_event WHERE action IN ('sync.device_hold.raised', 'sync.device_hold.reopened') AND scope ->> 'deviceId' = $1 ORDER BY seq",
        [device],
      );

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
        waiting: 3,
        waitingSince: expect.any(String),
        // The server had never heard from this device: the waiting starts no earlier than now.
        startFloor: "first_seen",
        // Opaque ids only: whose entries, and the locations of the device's sync scope.
        ownerTenantUserId: DEMO.users.carer.id,
        ownerBound: false,
        locationIds: [],
      });
    });

    it("hazard HZ-040 raises one task for the Registered Manager at the reporter's location, due when the hold escalates, never moved later, and closed at zero (round 5, C-H1 and S-M1)", async () => {
      await syncedOn(DEVICE, DEMO.users.carer.id, 30);
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
      // A later start never moves the due time later.
      const later = new Date(heldSince.getTime() + DAY);
      await report(h.tokens.carer, { held: 3, heldSince: later.toISOString() }, DEVICE);
      expect(new Date((await deviceTasks(DEVICE))[0]?.due_at ?? 0).getTime()).toBe(due);
      // A start earlier than the device's last report for this hold gave is taken as that report's
      // (round 6, N2), so a backdated start cannot make the task due at once.
      const earlier = new Date(heldSince.getTime() - 3_600_000);
      await report(h.tokens.carer, { held: 3, heldSince: earlier.toISOString() }, DEVICE);
      tasks = await deviceTasks(DEVICE);
      expect(tasks).toHaveLength(1);
      expect(new Date(tasks[0]?.due_at ?? 0).getTime()).toBe(due);
      const [floored] = await asTenant<{ scope: Record<string, unknown> }>(
        DEMO.tenantId,
        "SELECT scope FROM audit_event WHERE action = 'sync.device.report' AND resource_type = 'device' AND resource_id = $1 ORDER BY seq DESC LIMIT 1",
        [DEVICE],
      );
      expect(floored?.scope).toMatchObject({
        waitingSince: later.toISOString(),
        startFloor: "earlier_report",
      });
      // Entries a failed deletion left behind keep it open (C-M3).
      await report(h.tokens.carer, { blocked: 1 }, DEVICE);
      expect((await deviceTasks(DEVICE)).map((t) => t.status)).toEqual(["open"]);
      // Nothing waiting, from the reporter who raised it: the task closes.
      await report(h.tokens.carer, {}, DEVICE);
      tasks = await deviceTasks(DEVICE);
      expect(tasks.map((t) => t.status)).toEqual(["done"]);
      expect(tasks[0]?.updated_by).toBe(DEMO.users.carer.id);
      // Every raise and close is audited, with the task's opaque id.
      expect((await holdAudit(DEVICE)).map((r) => [r.action, r.resource_id])).toEqual([
        ["sync.device_hold.raised", tasks[0]?.id],
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
      // The owner's role covers the whole organisation and names no location.
      const device = "0199d000-0000-4000-8000-00000000de04";
      const heldSince = new Date(Date.now() - 3_600_000).toISOString();
      expect((await report(h.tokens.owner, { held: 1, heldSince }, device)).status).toBe(204);
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

    it("hazard HZ-008 reopens a device's task closed within the day and resets its escalation at most once a day, so a new hold always signals and raising again signals at most once more (round 6, N2; round 7, M1)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e10";
      await syncedOn(device, DEMO.users.carer.id, 30);
      const longAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
      await report(h.tokens.carer, { held: 1, heldSince: longAgo(10) }, device);
      const [raised] = await deviceTasks(device);
      // Due at once, and escalated by the worker.
      expect(new Date(raised?.due_at ?? 0).getTime()).toBeLessThan(Date.now());
      const escalate = () =>
        asTenant(
          DEMO.tenantId,
          "UPDATE task SET escalation_level = 1, escalated_at = now() WHERE id = $1",
          [raised?.id],
        );
      const state = () =>
        asTenant<{ id: string; status: string; escalation_level: number }>(
          DEMO.tenantId,
          "SELECT id, status, escalation_level FROM task WHERE source_type = 'device_hold' AND source_id = $1",
          [device],
        );
      await escalate();
      // Closed properly, then a new hold within the day: the same row, its escalation reset, so the
      // new hold signals (round 7, M1).
      await report(h.tokens.carer, {}, device);
      expect((await state()).map((t) => t.status)).toEqual(["done"]);
      await report(h.tokens.carer, { held: 1, heldSince: longAgo(20) }, device);
      expect(await state()).toEqual([{ id: raised?.id, status: "open", escalation_level: 0 }]);
      // It escalates again; another close and hold the same day keeps it escalated: no third signal.
      await escalate();
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await report(h.tokens.carer, {}, device);
        await report(h.tokens.carer, { held: 1, heldSince: longAgo(20) }, device);
      }
      expect(await state()).toEqual([{ id: raised?.id, status: "open", escalation_level: 1 }]);
      expect((await holdAudit(device)).map((r) => r.action)).toEqual([
        "sync.device_hold.raised",
        "sync.device_hold.closed",
        "sync.device_hold.reopened",
        "sync.device_hold.closed",
        "sync.device_hold.reopened",
        "sync.device_hold.closed",
        "sync.device_hold.reopened",
      ]);
      expect(
        (await raiseScopes(device))
          .filter((r) => r.action === "sync.device_hold.reopened")
          .map((r) => r.scope.escalationReset),
      ).toEqual([true, false, false]);
    });

    it("hazard HZ-008 merges each reporter's holds past the day's cap into one task, due at the earliest of them, and tells the location's Registered Manager once (round 6, N2; round 7, M2)", async () => {
      const devices = [1, 2, 3, 4, 5].map((n) => `0199d000-0000-4000-8000-0000000d0e0${n}`);
      for (const device of devices.slice(0, 3)) {
        expect((await report(h.tokens.carer, { held: 1 }, device)).status).toBe(204);
      }
      // Closing the tasks does not free the day's places.
      for (const device of devices.slice(0, 3)) await report(h.tokens.carer, {}, device);
      expect((await report(h.tokens.carer, { held: 1 }, devices[3])).status).toBe(204);
      const capped = () =>
        asTenant<{ id: string; status: string; due_at: Date; location_id: string | null }>(
          DEMO.tenantId,
          "SELECT id, status, due_at, location_id FROM task WHERE kind = 'sync.device_hold' AND source_type = 'device_hold_capped' AND source_id = $1 AND deleted_at IS NULL",
          [DEMO.users.carer.id],
        );
      const [first] = await capped();
      expect(first).toMatchObject({ status: "open", location_id: DEMO.locationId });
      // A later capped hold that started earlier brings the one task forward; no second task.
      const fifth = devices[4] ?? "";
      await syncedOn(fifth, DEMO.users.carer.id, 30);
      const earlier = new Date(Date.now() - 5 * DAY);
      await report(h.tokens.carer, { held: 1, heldSince: earlier.toISOString() }, fifth);
      const merged = await capped();
      expect(merged).toHaveLength(1);
      expect(merged[0]?.id).toBe(first?.id);
      expect(new Date(merged[0]?.due_at ?? 0).getTime()).toBe(earlier.getTime() + 7 * DAY);
      const tasks = await Promise.all(devices.map((d) => deviceTasks(d)));
      expect(tasks.map((t) => t.length)).toEqual([1, 1, 1, 0, 0]);
      expect((await holdAudit(devices[3] ?? "")).map((r) => [r.action, r.outcome])).toEqual([
        ["sync.device_hold.merged", "success"],
        ["sync.device_hold.capped", "denied"],
      ]);
      // In addition, one notice to the location's Registered Manager, with no personal data.
      const notices = await asTenant<{
        recipient_tenant_user_id: string;
        title: string;
        source_id: string;
      }>(
        DEMO.tenantId,
        "SELECT recipient_tenant_user_id, title, source_id FROM notification WHERE kind = 'sync.reporter_capped'",
      );
      expect(notices).toEqual([
        {
          recipient_tenant_user_id: DEMO.users.manager.id,
          title: "A member of staff reached today's limit on device tasks",
          source_id: DEMO.users.carer.id,
        },
      ]);
      // The capped-holds task stays until a manager completes it.
      await asTenant(DEMO.tenantId, "UPDATE task SET status = 'done' WHERE id = $1", [first?.id]);
    });

    it("hazard HZ-040 lets the hold's owner close the task another member's sign-in raised for them (round 6, M1)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e11";
      // The carer synced from the device before the hold (round 7, M1).
      await syncedOn(device, DEMO.users.carer.id, 30);
      const heldSince = new Date(Date.now() - DAY);
      // The next person to sign in on the device (here the agency worker) sends the carer's report.
      const forwarded = {
        held: 2,
        heldSince: heldSince.toISOString(),
        ownerTenantUserId: DEMO.users.carer.id,
        locationIds: [DEMO.locationId],
      };
      expect((await report(h.tokens.agency, forwarded, device)).status).toBe(204);
      const [raised] = await deviceTasks(device);
      expect(raised).toMatchObject({ status: "open", location_id: DEMO.locationId });
      expect(raised?.created_by).not.toBe(DEMO.users.carer.id);
      expect((await raiseScopes(device))[0]?.scope).toMatchObject({
        ownerTenantUserId: DEMO.users.carer.id,
      });
      // The carer signs in, the entries upload, and the carer's own report closes the task.
      expect(
        (await report(h.tokens.carer, { ownerTenantUserId: DEMO.users.carer.id }, device)).status,
      ).toBe(204);
      expect((await deviceTasks(device)).map((t) => t.status)).toEqual(["done"]);
      const [closed] = await asTenant<{ scope: Record<string, unknown> }>(
        DEMO.tenantId,
        "SELECT scope FROM audit_event WHERE action = 'sync.device_hold.closed' AND resource_id = $1",
        [raised?.id],
      );
      expect(closed?.scope).toEqual({ deviceId: device, because: "report", as: "owner" });
      // An owner who is not staff of this organisation is refused.
      const stranger = { ...forwarded, ownerTenantUserId: OTHER.managerId };
      expect((await report(h.tokens.agency, stranger, device)).status).toBe(422);
    });

    it("hazard HZ-040 takes a named owner who never used the device as a claim only: routed by the reporter, recorded, with no right to close (security review round 7, M1)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e17";
      // The carer names the organisation's owner, whose role covers every location, and other
      // organisations' and other homes' locations, with a start in the year 2000.
      const claim = {
        held: 1,
        heldSince: "2000-01-01T00:00:00.000Z",
        ownerTenantUserId: DEMO.users.owner.id,
        locationIds: [OTHER.locationId, LODGE.locationId, DEMO.locationId],
      };
      expect((await report(h.tokens.carer, claim, device)).status).toBe(204);
      const tasks = await deviceTasks(device);
      // Only at the carer's own location, and not due at once.
      expect(tasks.map((t) => t.location_id)).toEqual([DEMO.locationId]);
      expect(new Date(tasks[0]?.due_at ?? 0).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      expect((await raiseScopes(device))[0]?.scope).toMatchObject({
        ownerTenantUserId: DEMO.users.carer.id,
        claimedOwnerTenantUserId: DEMO.users.owner.id,
      });
      expect((await reportScopes(device))[0]).toMatchObject({
        ownerBound: false,
        claimedOwnerTenantUserId: DEMO.users.owner.id,
        startFloor: "first_seen",
      });
      // The named owner may close it only as the manager they are, never as its owner.
      await report(h.tokens.owner, {}, device);
      const [closed] = await asTenant<{ scope: Record<string, unknown> }>(
        DEMO.tenantId,
        "SELECT scope FROM audit_event WHERE action = 'sync.device_hold.closed' AND resource_id = $1",
        [tasks[0]?.id],
      );
      expect(closed?.scope).toMatchObject({ as: "manager" });
      // A claimed owner with no permission has no right to close at all.
      const other = "0199d000-0000-4000-8000-0000000d0e18";
      const agencyId = (
        await asTenant<{ id: string }>(
          DEMO.tenantId,
          "SELECT id FROM tenant_user WHERE email = 'agency@example.invalid' AND tenant_id = $1",
          [DEMO.tenantId],
        )
      )[0]?.id;
      await report(h.tokens.carer, { held: 1, ownerTenantUserId: agencyId }, other);
      await report(h.tokens.agency, {}, other);
      expect((await deviceTasks(other)).map((t) => t.status)).toEqual(["open"]);
      expect((await holdAudit(other)).map((r) => [r.action, r.outcome])).toContainEqual([
        "sync.device_hold.close_refused",
        "denied",
      ]);
    });

    it("hazard HZ-040 keeps a hold's start floor on the bound owner, so naming a new owner each report does not escape it (security review round 7, M1)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e19";
      await syncedOn(device, DEMO.users.carer.id, 30);
      const start = new Date(Date.now() - DAY);
      await report(h.tokens.carer, { held: 1, heldSince: start.toISOString() }, device);
      const [raised] = await deviceTasks(device);
      // Another member reports with a new owner and an earlier start each time.
      for (const owner of [DEMO.users.nurse.id, DEMO.users.manager.id, DEMO.users.owner.id]) {
        const earlier = new Date(Date.now() - 9 * DAY).toISOString();
        await report(
          h.tokens.agency,
          { held: 1, heldSince: earlier, ownerTenantUserId: owner },
          device,
        );
      }
      const [after] = await deviceTasks(device);
      expect(after?.due_at).toEqual(raised?.due_at);
      expect((await holdAudit(device)).map((r) => r.action)).toEqual(["sync.device_hold.raised"]);
      const scopes = await reportScopes(device);
      expect(scopes.slice(1).map((s) => [s.ownerTenantUserId, s.startFloor])).toEqual([
        [DEMO.users.carer.id, "earlier_report"],
        [DEMO.users.carer.id, "earlier_report"],
        [DEMO.users.carer.id, "earlier_report"],
      ]);
      expect(scopes.slice(1).map((s) => s.claimedOwnerTenantUserId)).toEqual([
        DEMO.users.nurse.id,
        DEMO.users.manager.id,
        DEMO.users.owner.id,
      ]);
    });

    it("hazard HZ-040 keeps the bound owner when a member who never used the device reopens its task (security review round 7, M1)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e1a";
      await syncedOn(device, DEMO.users.carer.id, 30);
      await report(h.tokens.carer, { held: 1 }, device);
      await report(h.tokens.carer, {}, device);
      // The agency worker has never used the device, and reports a hold on it.
      await report(h.tokens.agency, { held: 1 }, device);
      expect((await deviceTasks(device)).map((t) => t.status)).toEqual(["open"]);
      expect((await raiseScopes(device)).map((r) => [r.action, r.scope.ownerTenantUserId])).toEqual(
        [
          ["sync.device_hold.raised", DEMO.users.carer.id],
          ["sync.device_hold.reopened", DEMO.users.carer.id],
        ],
      );
      // So the agency worker gains no right to close the next hold; the carer still has it.
      await report(h.tokens.agency, {}, device);
      expect((await deviceTasks(device)).map((t) => t.status)).toEqual(["open"]);
      await report(h.tokens.carer, {}, device);
      const closes = await asTenant<{ scope: Record<string, unknown> }>(
        DEMO.tenantId,
        "SELECT scope FROM audit_event WHERE action = 'sync.device_hold.closed' AND scope ->> 'deviceId' = $1 ORDER BY seq",
        [device],
      );
      expect(closes.at(-1)?.scope).toMatchObject({ as: "owner" });
    });

    it("hazard HZ-040 never takes a hold's start earlier than the device's last report for it said, whoever reports (round 6, N2; security review round 7, L2)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e12";
      await syncedOn(device, DEMO.users.carer.id, 30);
      const start = new Date(Date.now() - DAY);
      await report(h.tokens.agency, { held: 1, heldSince: start.toISOString() }, device);
      const [raised] = await deviceTasks(device);
      // The device's own owner then reports an earlier start: one device, one hold, one floor.
      const earlier = new Date(start.getTime() - DAY);
      await report(h.tokens.carer, { held: 1, heldSince: earlier.toISOString() }, device);
      const [after] = await deviceTasks(device);
      expect(after?.due_at).toEqual(raised?.due_at);
      expect((await reportScopes(device)).at(-1)).toMatchObject({
        ownerTenantUserId: DEMO.users.carer.id,
        startFloor: "earlier_report",
      });
      expect((await holdAudit(device)).map((r) => r.action)).toEqual(["sync.device_hold.raised"]);
    });

    it("hazard HZ-040 routes to every location only from the reporter's own organisation-wide role, never from a named owner's (security review round 7, L1)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e1b";
      // The organisation's owner, whose role covers every location, has used this device.
      await syncedOn(device, DEMO.users.owner.id, 30);
      await report(
        h.tokens.carer,
        {
          held: 1,
          ownerTenantUserId: DEMO.users.owner.id,
          locationIds: [LODGE.locationId, DEMO.locationId],
        },
        device,
      );
      expect((await deviceTasks(device)).map((t) => t.location_id)).toEqual([DEMO.locationId]);
    });

    it("hazard HZ-008 signals a hold reopened after the day's reset was used once the reset is due, and only once (clinical review round 8, M2)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e1c";
      await syncedOn(device, DEMO.users.carer.id, 30);
      const longAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
      const level = async () =>
        (
          await asTenant<{ escalation_level: number }>(
            DEMO.tenantId,
            "SELECT escalation_level FROM task WHERE source_type = 'device_hold' AND source_id = $1",
            [device],
          )
        ).map((t) => t.escalation_level);
      const escalate = () =>
        asTenant(
          DEMO.tenantId,
          "UPDATE task SET escalation_level = 1, escalated_at = now() WHERE source_type = 'device_hold' AND source_id = $1",
          [device],
        );
      // A reopen of a task that never escalated has nothing to reset, and uses none of the day's.
      await report(h.tokens.carer, { held: 1, heldSince: longAgo(10) }, device);
      await report(h.tokens.carer, {}, device);
      await report(h.tokens.carer, { held: 1, heldSince: longAgo(10) }, device);
      expect((await raiseScopes(device)).at(-1)?.scope).not.toHaveProperty("escalationReset");
      // Hold A escalates and is cleared; hold B reopens it the same day: the day's reset is used.
      await escalate();
      await report(h.tokens.carer, {}, device);
      await report(h.tokens.carer, { held: 1, heldSince: longAgo(10) }, device);
      await escalate();
      await report(h.tokens.carer, {}, device);
      await report(h.tokens.carer, { held: 1, heldSince: longAgo(10) }, device);
      expect(await level()).toEqual([1]);
      expect((await raiseScopes(device)).at(-1)?.scope).toMatchObject({ escalationReset: false });
      // The device re-reports while hold B waits: a day later the reset is due, so it signals.
      const carer = {
        tenantId: DEMO.tenantId,
        tenantUserId: DEMO.users.carer.id,
        session: { authUserId: h.authIds.carer },
        effective: { roleKeys: ["care_worker"] },
        deviceId: device,
        ip: null,
      } as unknown as TenantAccess;
      const later = (hours: number) =>
        recordDeviceHold(
          h.handle.services.db,
          carer,
          device,
          {
            unsent: 0,
            refused: 0,
            held: 1,
            blocked: 0,
            oldestAgeSeconds: null,
            heldSince: longAgo(10),
            reportedAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
          },
          new Date(Date.now() + hours * 3_600_000),
        );
      expect(await later(12)).toBe("kept");
      expect(await level()).toEqual([1]);
      expect(await later(25)).toBe("reset");
      expect(await level()).toEqual([0]);
      // It escalates again; later reports leave it so: once, not every day.
      await escalate();
      expect(await later(50)).toBe("kept");
      expect(await level()).toEqual([1]);
    });

    it("hazard HZ-040 raises the task at each location of the device's scope where the owner or reporter works, and closes them together (round 6, M2)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e13";
      await syncedOn(device, DEMO.users.carer.id, 30);
      // The agency worker works at the Lodge today; the carer, whose entries these are, at the home.
      await asTenant(
        DEMO.tenantId,
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
         SELECT tu.id, r.id, $1, 'Lodge shift'
         FROM tenant_user tu, role r
         WHERE tu.email = 'agency@example.invalid' AND tu.tenant_id = $2
           AND r.key = 'agency_worker' AND r.tenant_id = $2`,
        [LODGE.locationId, DEMO.tenantId],
      );
      const unknownLocation = "0199d000-0000-4000-8000-0000000d0e99";
      await report(
        h.tokens.agency,
        {
          held: 3,
          ownerTenantUserId: DEMO.users.carer.id,
          locationIds: [LODGE.locationId, DEMO.locationId, OTHER.locationId, unknownLocation],
        },
        device,
      );
      await asTenant(
        DEMO.tenantId,
        "UPDATE role_assignment SET deleted_at = now() WHERE reason = 'Lodge shift' AND deleted_at IS NULL",
      );
      const tasks = await deviceTasks(device);
      expect(tasks.map((t) => t.location_id).sort()).toEqual(
        [DEMO.locationId, LODGE.locationId].sort(),
      );
      // The home's Registered Manager sees the home's task only.
      const seen = await visibleTo("manager");
      expect(tasks.filter((t) => seen.includes(t.id)).map((t) => t.location_id)).toEqual([
        DEMO.locationId,
      ]);
      // One report from the owner closes both.
      await report(h.tokens.carer, {}, device);
      expect((await deviceTasks(device)).map((t) => t.status)).toEqual(["done", "done"]);
    });

    it("hazard HZ-040 closes every Registered Manager's copy with one report or one deletion (round 6)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e14";
      const second = "0194d000-0000-7000-8000-0000000003f2";
      await asTenant(
        DEMO.tenantId,
        "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Rhi Second', 'rhi@example.invalid', 'active')",
        [second],
      );
      await asTenant(
        DEMO.tenantId,
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
         SELECT $1, id, $2, 'Second manager' FROM role WHERE key = 'registered_manager' AND tenant_id = $3`,
        [second, LODGE.locationId, DEMO.tenantId],
      );
      // The owner's role names no location, so each Registered Manager gets a copy.
      await report(h.tokens.owner, { held: 1 }, device);
      const copies = async () =>
        (await deviceTasks(device)).map((t) => [t.assignee_tenant_user_id, t.status]);
      expect((await copies()).sort()).toEqual(
        [
          [DEMO.users.manager.id, "open"],
          [second, "open"],
        ].sort(),
      );
      await report(h.tokens.owner, {}, device);
      expect((await copies()).map(([, status]) => status)).toEqual(["done", "done"]);
      // Reopened together, then closed together by a recorded deletion of the held entries.
      await report(h.tokens.owner, { held: 1 }, device);
      expect((await copies()).map(([, status]) => status)).toEqual(["open", "open"]);
      const deletion = {
        id: crypto.randomUUID(),
        kind: "held_deleted",
        stage: "requested",
        reasonCode: "recorded_elsewhere",
        ownerTenantUserId: DEMO.users.owner.id,
        deletedByTenantUserId: DEMO.users.owner.id,
        entryIds: [],
        personIds: [],
        count: 1,
        discardedAt: new Date().toISOString(),
        deviceId: device,
      };
      for (const stage of ["requested", "deleted"]) {
        const sent = await demo("owner", "/v1/sync/discards", {
          method: "POST",
          body: { ...deletion, stage },
        });
        expect(sent.status).toBe(200);
      }
      expect((await copies()).map(([, status]) => status)).toEqual(["done", "done"]);
      await asTenant(
        DEMO.tenantId,
        "UPDATE role_assignment SET deleted_at = now() WHERE reason = 'Second manager'",
      );
    });

    it("hazard HZ-040 lets a manager close a device's task only at its locations (round 6)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e15";
      await report(h.tokens.carer, { held: 1 }, device);
      // The agency worker leads at the Lodge only, where the task is not.
      await asTenant(
        DEMO.tenantId,
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
         SELECT tu.id, r.id, $1, 'Lodge lead'
         FROM tenant_user tu, role r
         WHERE tu.email = 'agency@example.invalid' AND tu.tenant_id = $2
           AND r.key = 'clinical_lead' AND r.tenant_id = $2`,
        [LODGE.locationId, DEMO.tenantId],
      );
      await report(h.tokens.agency, {}, device);
      await asTenant(
        DEMO.tenantId,
        "UPDATE role_assignment SET deleted_at = now() WHERE reason = 'Lodge lead' AND deleted_at IS NULL",
      );
      expect((await deviceTasks(device)).map((t) => t.status)).toEqual(["open"]);
      expect((await holdAudit(device)).map((r) => [r.action, r.outcome])).toContainEqual([
        "sync.device_hold.close_refused",
        "denied",
      ]);
    });

    it("hazard HZ-008 resets a task's escalation when a new hold follows a refused close, once a day (round 6, M1)", async () => {
      const device = "0199d000-0000-4000-8000-0000000d0e16";
      await syncedOn(device, DEMO.users.carer.id, 30);
      await report(
        h.tokens.carer,
        { held: 1, heldSince: new Date(Date.now() - 10 * DAY).toISOString() },
        device,
      );
      const [raised] = await deviceTasks(device);
      await asTenant(
        DEMO.tenantId,
        "UPDATE task SET escalation_level = 1, escalated_at = now() WHERE id = $1",
        [raised?.id],
      );
      const level = async () =>
        (
          await asTenant<{ escalation_level: number; due_at: Date }>(
            DEMO.tenantId,
            "SELECT escalation_level, due_at FROM task WHERE id = $1",
            [raised?.id],
          )
        )[0];
      // Someone who may not close it reports nothing waiting; then a new hold arrives.
      await report(h.tokens.agency, {}, device);
      await report(h.tokens.agency, { held: 1, heldSince: new Date().toISOString() }, device);
      // The task signals again, and its due time is never later.
      expect(await level()).toEqual({ escalation_level: 0, due_at: raised?.due_at });
      await asTenant(DEMO.tenantId, "UPDATE task SET escalation_level = 1 WHERE id = $1", [
        raised?.id,
      ]);
      await report(h.tokens.agency, {}, device);
      await report(h.tokens.agency, { held: 1 }, device);
      expect((await level())?.escalation_level).toBe(1);
      expect((await holdAudit(device)).map((r) => r.action)).toEqual([
        "sync.device_hold.raised",
        "sync.device_hold.close_refused",
        "sync.device_hold.reset",
        "sync.device_hold.close_refused",
      ]);
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
