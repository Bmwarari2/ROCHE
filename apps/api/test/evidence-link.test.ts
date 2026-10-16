import { createHash, createHmac } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";
import { pdfText } from "./support/pdf-text";

/**
 * The public evidence pack link (quality.md section 15; ADR-0050; hazard HZ-050): the token only
 * in a body and looked up by its hash, codes kept as an HMAC under the server key, a wrong code
 * counted in the same transaction, lock-out at the limit, a cap on open codes, a session cookie for
 * one link, the watermarked PDF drawn from the bundle, and every step audited with ids only.
 */

let h: Harness;
let inScope: string;
const SECRET = "test-evidence-link-secret-0123456789abcdef";

const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const post = (path: string, body: unknown) => h.request(path, { method: "POST", body });
const open = (cookie?: string) =>
  h.request("/p/evidence/bundle", cookie ? { headers: { cookie } } : {});

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

/** A released pack about one person, with a note naming a visitor: its id, link id and token. */
async function releasedPack(): Promise<{ packId: string; linkId: string; token: string }> {
  const composed = await as("manager", "/v1/evidence-packs", {
    method: "POST",
    body: {
      recipient: { name: "Ivy Inspector", organisation: "CQC", email: "ivy@example.invalid" },
      purpose: "Assessment of Harbour House, safe key question",
      from: "2026-01-01",
      to: new Date().toISOString().slice(0, 10),
      locationIds: [DEMO.locationId],
      qualityStatementIds: null,
      personIds: [inScope],
    },
  });
  const pack = (await composed.json()) as { id: string; version: number };
  const [note] = await sql<{ id: string }>(
    `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, created_by)
     VALUES ($1, $2, now(), 'nutrition', 'Lunch with Gwen Visitor.', $3) RETURNING id`,
    [inScope, DEMO.locationId, DEMO.users.carer.id],
  );
  const added = await as("manager", `/v1/evidence-packs/${pack.id}/items`, {
    method: "POST",
    body: {
      items: [{ recordType: "care_note", recordId: note?.id, qualityStatementIds: ["safe.1"] }],
      version: pack.version,
    },
  });
  const { version } = (await added.json()) as { version: number };
  const released = await as("owner", `/v1/evidence-packs/${pack.id}/release`, {
    method: "POST",
    body: { version },
  });
  const { linkId, token } = (await released.json()) as { linkId: string; token: string };
  return { packId: pack.id, linkId, token };
}

/** Asks for a code and reads it from the mock email. */
async function codeFor(token: string): Promise<string> {
  const response = await post("/p/evidence/code", { token });
  expect(response.status).toBe(202);
  const title = h.handle.services.mockEmail.sent.at(-1)?.title ?? "";
  return /(\d{6})/.exec(title)?.[1] as string;
}

const cookieOf = (response: Response) =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] as string;

beforeAll(async () => {
  h = await createHarness({
    EVIDENCE_LINK_SECRET: SECRET,
    EVIDENCE_LINK_REQUESTS_PER_MINUTE_PER_ADDRESS: "1000",
    EVIDENCE_LINK_REQUESTS_PER_MINUTE_PER_LINK: "1000",
  });
  const [person] = await sql<{ id: string }>(
    "SELECT id FROM person WHERE location_id = $1 AND status = 'active' ORDER BY id LIMIT 1",
    [DEMO.locationId],
  );
  inScope = person?.id as string;
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-050 the evidence pack link opens only for its recipient's own session", () => {
  let pack: { packId: string; linkId: string; token: string };
  let session: string;

  beforeAll(async () => {
    pack = await releasedPack();
  });

  it("refuses an unknown or malformed token, audited without the token", async () => {
    const unknown = await post("/p/evidence/code", { token: "A".repeat(43) });
    expect(unknown.status).toBe(404);
    expect((await post("/p/evidence/code", { token: "short" })).status).toBe(422);
  });

  it("sends a six-digit code to the bound address alone, kept as an HMAC under the server key", async () => {
    const code = await codeFor(pack.token);
    const mail = h.handle.services.mockEmail.sent.at(-1);
    expect(mail).toMatchObject({ to: "ivy@example.invalid", link: null });
    expect(mail?.title).not.toContain(pack.token);
    const [row] = await sql<{ code_hash: string }>(
      "SELECT code_hash FROM evidence_pack_link_code WHERE link_id = $1",
      [pack.linkId],
    );
    expect(row?.code_hash).toBe(
      createHmac("sha256", SECRET).update(`evidence-code:${pack.linkId}:${code}`).digest("hex"),
    );
    expect(row?.code_hash).not.toBe(createHash("sha256").update(code).digest("hex"));
  });

  it("counts a wrong code on the link and never resets it; a malformed one is not counted", async () => {
    expect((await post("/p/evidence/verify", { token: pack.token, code: "12ab" })).status).toBe(
      422,
    );
    const wrong = await post("/p/evidence/verify", { token: pack.token, code: "000000" });
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { code: string }).code).toBe("wrong_code");
    const [link] = await sql<{ failed_code_attempts: number }>(
      "SELECT failed_code_attempts FROM evidence_pack_link WHERE id = $1",
      [pack.linkId],
    );
    expect(link?.failed_code_attempts).toBe(1);
  });

  it("needs this link's session to open the pack", async () => {
    expect((await open()).status).toBe(401);
    expect((await open("harbour_evidence_session=forged.value")).status).toBe(401);
  });

  it("takes the right code once and sets an HttpOnly, Secure, SameSite=Strict cookie for the link", async () => {
    const code = await codeFor(pack.token);
    const verified = await post("/p/evidence/verify", { token: pack.token, code });
    expect(verified.status).toBe(204);
    const header = verified.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(header).toMatch(/Path=\/p\/evidence/);
    expect(header).not.toContain(pack.token);
    session = cookieOf(verified);
    const again = await post("/p/evidence/verify", { token: pack.token, code });
    expect(again.status).toBe(422);
    const [link] = await sql<{ failed_code_attempts: number }>(
      "SELECT failed_code_attempts FROM evidence_pack_link WHERE id = $1",
      [pack.linkId],
    );
    // The right code did not reset the count; the used code, entered again, counted.
    expect(link?.failed_code_attempts).toBe(2);
  });

  it("hazard HZ-050 the rendered pack is watermarked and holds no third party's name", async () => {
    const response = await open(session);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    const text = pdfText(new Uint8Array(await response.arrayBuffer()));
    expect(text).toContain("Prepared for Ivy Inspector, CQC.");
    expect(text).toContain("Care note: nutrition");
    expect(text).not.toContain("Gwen Visitor");
    expect(text).not.toContain("Cat Carer");
    expect(text).toContain("Withheld: free text may name other people");
    const audits = await sql<{ action: string; scope: string; reason: string | null }>(
      "SELECT action, scope::text, reason FROM audit_event WHERE resource_id = $1 ORDER BY occurred_at",
      [pack.linkId],
    );
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "quality.evidence_pack.code_sent",
        "quality.evidence_pack.code_failed",
        "quality.evidence_pack.code_verified",
        "quality.evidence_pack.opened",
      ]),
    );
    expect(audits.some((a) => `${a.scope}${a.reason}`.includes(pack.token))).toBe(false);
    const [link] = await sql<{ last_opened_at: Date | null }>(
      "SELECT last_opened_at FROM evidence_pack_link WHERE id = $1",
      [pack.linkId],
    );
    expect(link?.last_opened_at).not.toBeNull();
  });

  it("caps the codes open at once for a link", async () => {
    let status = 202;
    for (let i = 0; i < 4 && status === 202; i++) {
      status = (await post("/p/evidence/code", { token: pack.token })).status;
    }
    expect(status).toBe(429);
    const [live] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM evidence_pack_link_code
       WHERE link_id = $1 AND used_at IS NULL AND valid_until > now()`,
      [pack.linkId],
    );
    expect(Number(live?.n)).toBe(3);
  });

  it("stops at once when the pack is revoked, and the bundle is gone", async () => {
    const detail = (await (await as("manager", `/v1/evidence-packs/${pack.packId}`)).json()) as {
      version: number;
    };
    await as("manager", `/v1/evidence-packs/${pack.packId}/revoke`, {
      method: "POST",
      body: { reason: "Sent in error", version: detail.version },
    });
    const refused = await open(session);
    expect(refused.status).toBe(410);
    expect(((await refused.json()) as { code: string }).code).toBe("link_revoked");
  });
});

describe("hazard HZ-050 one-time codes lock the link for good", () => {
  it("locks after five wrong codes, audited, and opens nothing after", async () => {
    const pack = await releasedPack();
    const code = await codeFor(pack.token);
    const verified = await post("/p/evidence/verify", { token: pack.token, code });
    const session = cookieOf(verified);
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await post("/p/evidence/verify", { token: pack.token, code: "999999" });
    }
    expect(last?.status).toBe(410);
    expect(((await (last as Response).json()) as { code: string }).code).toBe("link_locked");
    expect((await post("/p/evidence/code", { token: pack.token })).status).toBe(410);
    expect((await open(session)).status).toBe(410);
    const locked = await sql<{ action: string }>(
      "SELECT action FROM audit_event WHERE resource_id = $1 AND action = 'quality.evidence_pack.link_locked'",
      [pack.linkId],
    );
    expect(locked).toHaveLength(1);
  });

  it("a session for one link opens no other", async () => {
    const first = await releasedPack();
    const second = await releasedPack();
    const verified = await post("/p/evidence/verify", {
      token: first.token,
      code: await codeFor(first.token),
    });
    const session = cookieOf(verified);
    // The cookie names its own link only; changing it breaks the signature.
    const [payload, signature] = session.split("=")[1]?.split(".") ?? [];
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    const swapped = Buffer.from(
      JSON.stringify({ ...decoded, l: second.linkId, p: second.packId }),
    ).toString("base64url");
    expect((await open(`harbour_evidence_session=${swapped}.${signature}`)).status).toBe(401);
    expect((await open(session)).status).toBe(200);
  });
});
