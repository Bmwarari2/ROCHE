import type { Branding, DocumentItem, Me, ProblemDetails } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EICAR } from "../src/integrations/storage";
import { createHarness, type Harness } from "./support/harness";

/**
 * White-label branding (PLAT-002; platform.md, white-label branding): every member reads it, only
 * platform.tenant.manage sets it, an accent that fails contrast is refused with why and never
 * stored, and the logo goes through the document store's checks and is served only here.
 */

let h: Harness;

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown; raw?: { bytes: Uint8Array; contentType: string } } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });

const read = async (user = "carer") => json<Branding>(await as(user, "/v1/branding"));
const save = async (displayName: string | null, accent: string | null, user = "owner") =>
  as(user, "/v1/branding", {
    method: "PUT",
    body: { displayName, accent, expectedVersion: (await read("owner")).version },
  });

async function audits(action: string) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
    const { rows } = await client.query<{ outcome: string; reason: string | null; scope: unknown }>(
      "SELECT outcome, reason, scope FROM audit_event WHERE action = $1 ORDER BY seq",
      [action],
    );
    await client.query("COMMIT");
    return rows;
  } finally {
    client.release();
  }
}

describe("branding: reading", () => {
  it("is read by any member, with the registered name and no accent or logo at first", async () => {
    const branding = await read("carer");
    expect(branding).toMatchObject({ accent: null, logo: null });
    expect(branding.registeredName.length).toBeGreaterThan(0);
  });

  it("needs a session", async () => {
    const response = await h.request("/v1/branding", { tenant: DEMO.tenantId });
    expect(response.status).toBe(401);
  });
});

describe("branding: the display name and accent", () => {
  it("saves a name and a passing accent, normalised, and the shell's /v1/me shows them", async () => {
    const response = await save("  Lodge   Care Homes ", "#0074E8");
    expect(response.status).toBe(200);
    expect(await json<Branding>(response)).toMatchObject({
      displayName: "Lodge Care Homes",
      accent: "#0074e8",
    });
    const me = await json<Me>(await as("carer", "/v1/me"));
    expect(me.tenant).toMatchObject({ name: "Lodge Care Homes", brandAccent: "#0074e8" });
    const rows = await audits("platform.branding.updated");
    expect(rows.at(-1)).toMatchObject({
      outcome: "success",
      scope: { changed: ["displayName", "accent"], accentAfter: "#0074e8" },
    });
  });

  it.each([
    ["#ffff00", "too light", "#"],
    ["#0071e3", "too dark", "#"],
  ])("refuses %s as %s, suggests a colour that works and stores nothing", async (accent, why) => {
    const before = await read("owner");
    const response = await save("Lodge Care Homes", accent);
    expect(response.status).toBe(422);
    const problem = await json<ProblemDetails>(response);
    expect(problem.code).toBe("accent_contrast");
    expect(problem.detail).toContain(`This colour is ${why}`);
    expect(problem.detail).toMatch(/Try #[0-9a-f]{6}, the nearest colour that works\./);
    const after = await read("owner");
    expect(after.accent).toBe(before.accent);
    expect(after.version).toBe(before.version);
    expect((await audits("platform.branding.updated")).at(-1)).toMatchObject({
      outcome: "denied",
    });
  });

  it.each([
    ["blue", null, "accent_contrast", "six-digit hex code"],
    [null, "x".repeat(81), "invalid", "80 characters"],
    [null, "Bell\u0007", "invalid", "cannot be shown"],
  ])("refuses accent %j or name %j (%s)", async (accent, name, code, words) => {
    const response = await save(name, accent);
    expect(response.status).toBe(422);
    const problem = await json<ProblemDetails>(response);
    expect(problem.code).toBe(code);
    expect(problem.detail).toContain(words);
  });

  it("clears both with blanks, so the registered name and Harbour's accent return", async () => {
    const response = await save("   ", "");
    expect(response.status).toBe(200);
    expect(await json<Branding>(response)).toMatchObject({ displayName: null, accent: null });
  });

  it("refuses a stale version", async () => {
    const response = await as("owner", "/v1/branding", {
      method: "PUT",
      body: { displayName: null, accent: null, expectedVersion: -1 },
    });
    expect(response.status).toBe(409);
  });

  it("refuses members without platform.tenant.manage", async () => {
    for (const user of ["manager", "carer"]) {
      const response = await save("Not mine", "#0074e8", user);
      expect(response.status).toBe(403);
    }
  });
});

describe("branding: the logo", () => {
  it("stores a logo, serves it to any member with safe headers, and removes it", async () => {
    const put = await as("owner", "/v1/branding/logo", {
      method: "PUT",
      raw: { bytes: PNG, contentType: "image/png" },
    });
    expect(put.status).toBe(201);
    const item = await json<DocumentItem>(put);
    expect(item).toMatchObject({ category: "organisation_logo", status: "available" });

    const branding = await read("carer");
    expect(branding.logo).toEqual({ documentId: item.id, contentType: "image/png" });
    const me = await json<Me>(await as("carer", "/v1/me"));
    expect(me.tenant.logoDocumentId).toBe(item.id);

    const logo = await as("carer", "/v1/branding/logo");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(logo.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(PNG);

    // Never through the general document routes, which serve policies and people's documents.
    expect((await as("carer", `/v1/documents/${item.id}/content`)).status).toBe(404);

    const removed = await as("owner", "/v1/branding/logo", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await json<Branding>(removed)).logo).toBeNull();
    expect((await as("carer", "/v1/branding/logo")).status).toBe(404);
    expect((await audits("platform.branding.logo")).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses an SVG, a PDF, a file over 512 KB and an infected file", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
    const big = new Uint8Array(600 * 1024);
    big.set(PNG);
    const infected = new Uint8Array([...PNG, ...new TextEncoder().encode(EICAR)]);
    for (const [bytes, type] of [
      [svg, "image/png"],
      [pdf, "image/png"],
      [big, "image/png"],
      [infected, "image/png"],
    ] as const) {
      const response = await as("owner", "/v1/branding/logo", {
        method: "PUT",
        raw: { bytes, contentType: type },
      });
      expect(response.status).toBe(422);
    }
    expect((await read("owner")).logo).toBeNull();
  });

  it("refuses the logo through the general upload route and from other members", async () => {
    const general = await as("owner", "/v1/documents?category=organisation_logo&title=Logo", {
      method: "POST",
      raw: { bytes: PNG, contentType: "image/png" },
    });
    expect(general.status).toBe(422);
    expect((await json<ProblemDetails>(general)).detail).toContain("branding page");
    const manager = await as("manager", "/v1/branding/logo", {
      method: "PUT",
      raw: { bytes: PNG, contentType: "image/png" },
    });
    expect(manager.status).toBe(403);
    const remove = await as("carer", "/v1/branding/logo", { method: "DELETE" });
    expect(remove.status).toBe(403);
  });
});
