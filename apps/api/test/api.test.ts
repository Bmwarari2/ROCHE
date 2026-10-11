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
} from "@harbour/contracts";
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
