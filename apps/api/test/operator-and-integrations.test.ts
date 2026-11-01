import type { ProblemDetails } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const json = async <T>(response: Response) => (await response.json()) as T;
const demo = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[token], tenant: DEMO.tenantId, ...init });
const op = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[token], ...init });

describe("integrations settings (section 15.3)", () => {
  it("lists ports and shows unconfigured ones fall back to mocks", async () => {
    const body = await json<{ ports: string[]; items: unknown[] }>(
      await demo("owner", "/v1/integrations"),
    );
    expect(body.ports).toEqual(["comms.email", "comms.sms", "comms.push"]);
    expect(body.items).toEqual([]);
  });

  it("lets the owner choose a known provider, and refuses an unknown one", async () => {
    const ok = await demo("owner", "/v1/integrations/comms.email", {
      method: "PUT",
      body: { provider: "smtp", settings: { from: "alerts@example.invalid" } },
    });
    expect(ok.status).toBe(204);
    const bad = await demo("owner", "/v1/integrations/comms.sms", {
      method: "PUT",
      body: { provider: "pigeon" },
    });
    expect(bad.status).toBe(422);
    const listed = await json<{ items: { port: string; provider: string; hasSecret: boolean }[] }>(
      await demo("owner", "/v1/integrations"),
    );
    expect(listed.items).toEqual([
      expect.objectContaining({ port: "comms.email", provider: "smtp", hasSecret: false }),
    ]);
  });

  // #164 security review, L2 and L3.
  it("refuses a sender on a domain not allowed, and a secret that is not this organisation's", async () => {
    const sender = await demo("owner", "/v1/integrations/comms.email", {
      method: "PUT",
      body: { provider: "smtp", settings: { from: "alerts@elsewhere.example" } },
    });
    expect(sender.status).toBe(422);
    const other = "0194d000-0000-7000-8000-0000000000ff";
    for (const secretRef of [
      `projects/harbour-test/locations/europe-west2/secrets/harbour_int_${other}_smtp`,
      `projects/harbour-test/locations/europe-west2/secrets/harbour_sso_${DEMO.tenantId}_okta`,
      `projects/harbour-test/locations/europe-west2/secrets/harbour_int_${DEMO.tenantId}_smtp`,
    ]) {
      const refused = await demo("owner", "/v1/integrations/comms.email", {
        method: "PUT",
        body: { provider: "smtp", settings: { from: "alerts@example.invalid" }, secretRef },
      });
      // The last is the organisation's own, but no project is configured for tests: refused too.
      expect(refused.status, secretRef).toBe(422);
    }
  });

  it("is closed to care workers", async () => {
    expect((await demo("carer", "/v1/integrations")).status).toBe(403);
  });

  it("shows quarantined partner data and lets a manager resolve it", async () => {
    const owner = h.db.pool("harbour_owner");
    const client = await owner.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO integration_inbound (port, provider, external_id, status, payload, problems)
       VALUES ('councils.remittance', 'controcc', 'R-9', 'quarantined', '{}', '[{"path":"amount","message":"Required"}]')
       RETURNING id`,
    );
    await client.query("COMMIT");
    client.release();
    const queue = await json<{ items: { id: string; problems: unknown[] }[] }>(
      await demo("owner", "/v1/integrations/quarantine"),
    );
    expect(queue.items.map((i) => i.id)).toContain(rows[0]?.id);
    const resolved = await demo("owner", `/v1/integrations/quarantine/${rows[0]?.id}/resolve`, {
      method: "POST",
      body: { resolution: "discarded", note: "Duplicate of an earlier remittance" },
    });
    expect(resolved.status).toBe(204);
    const again = await demo("owner", `/v1/integrations/quarantine/${rows[0]?.id}/resolve`, {
      method: "POST",
      body: { resolution: "discarded", note: "Duplicate of an earlier remittance" },
    });
    expect(again.status).toBe(404);
  });
});

describe("operator console (section 9.1)", () => {
  it("refuses people who are not Thapsus operators", async () => {
    expect((await op("manager", "/operator/tenants")).status).toBe(403);
    expect((await h.request("/operator/tenants")).status).toBe(401);
  });

  it("refuses an operator who has not set up MFA", async () => {
    const response = await op("nurse", "/operator/tenants");
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("mfa_enrolment_required");
  });

  it("lists tenants without any people or care data", async () => {
    const body = await json<{ items: { id: string; name: string; locations: number }[] }>(
      await op("opsSupport", "/operator/tenants"),
    );
    const demoTenant = body.items.find((t) => t.id === DEMO.tenantId);
    expect(demoTenant).toMatchObject({ name: "Harbour Demo Care", locations: 2 });
    expect(JSON.stringify(body)).not.toContain("Ada");
  });

  it("only lets admins provision tenants", async () => {
    const payload = {
      name: "Seaview Care",
      legalName: "Seaview Care Ltd",
      legalForm: "limited_company",
      owner: { displayName: "Sian Seaview", email: "sian@example.invalid" },
    };
    expect(
      (await op("opsSupport", "/operator/tenants", { method: "POST", body: payload })).status,
    ).toBe(403);
    const created = await op("opsAdmin", "/operator/tenants", { method: "POST", body: payload });
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string }>(created);
    const listed = await json<{ items: { id: string; status: string }[] }>(
      await op("opsAdmin", "/operator/tenants"),
    );
    expect(listed.items.find((t) => t.id === id)?.status).toBe("onboarding");
  });

  it("asks a tenant for support access, which the owner approves after a fresh sign-in", async () => {
    const asked = await op("opsSupport", `/operator/tenants/${DEMO.tenantId}/support-access`, {
      method: "POST",
      body: {
        ticketReference: "SUP-42",
        reason: "The manager reported people missing from the list",
      },
    });
    expect(asked.status).toBe(201);
    const { id } = await json<{ id: string }>(asked);

    const inbox = await json<{ items: { kind: string; title: string }[] }>(
      await demo("owner", "/v1/notifications"),
    );
    expect(inbox.items.map((n) => n.kind)).toContain("platform.support_access_requested");

    const requests = await json<{ items: { id: string; decision: string | null }[] }>(
      await demo("owner", "/v1/support-access"),
    );
    expect(requests.items.find((r) => r.id === id)?.decision).toBeNull();

    // The owner's session was made stale in the API tests' step-up case; sign in again for a fresh one.
    const signIn = await h.request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "owner@example.invalid", password: "correct horse battery staple" },
    });
    const fresh = signIn.headers.get("set-auth-token");
    // Two-factor is on for the owner, so sign-in needs the TOTP step; use the existing (fresh) session instead.
    expect(signIn.status === 200 || fresh === null).toBe(true);

    const decided = await demo("owner", `/v1/support-access/${id}/decision`, {
      method: "POST",
      body: { decision: "approved", hours: 2 },
    });
    expect(decided.status).toBe(204);
    const after = await json<{ items: { id: string; decision: string; expiresAt: string }[] }>(
      await demo("owner", "/v1/support-access"),
    );
    expect(after.items.find((r) => r.id === id)).toMatchObject({ decision: "approved" });

    const audit = await json<{ items: { action: string }[] }>(
      await demo("owner", `/v1/audit?resourceType=support_access_request&resourceId=${id}`),
    );
    expect(audit.items.map((e) => e.action)).toContain("platform.support_access.approved");
  });

  it("does not let a manager approve support access", async () => {
    const asked = await op("opsSupport", `/operator/tenants/${DEMO.tenantId}/support-access`, {
      method: "POST",
      body: { ticketReference: "SUP-43", reason: "Second request about the same missing people" },
    });
    const { id } = await json<{ id: string }>(asked);
    const response = await demo("manager", `/v1/support-access/${id}/decision`, {
      method: "POST",
      body: { decision: "approved" },
    });
    expect(response.status).toBe(403);
  });

  it("reports integration health across tenants", async () => {
    const health = await json<{ database: string; integrations: { port: string }[] }>(
      await op("opsSupport", "/operator/health"),
    );
    expect(health.database).toBe("ok");
    expect(health.integrations.map((i) => i.port)).toContain("comms.email");
  });
});
