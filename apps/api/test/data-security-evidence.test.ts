import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remindDataSecurityRenewals } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Data security evidence (QUAL-012; quality.md section 18): quality.dsar.manage across the
 * organisation only; the overview worked out from the rate table on every read (missing never
 * current); assertion rules (met needs evidence, notes when not met or not applicable); evidence
 * is an available organisation document; one submission per year; renewal tasks raised once; audit
 * with ids and codes only.
 */

let h: Harness;
let orgDocument = "";
let personDocument = "";

const HASH = "b".repeat(64);
const as = (who: string) => ({ token: h.tokens[who], tenant: DEMO.tenantId });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const get = (path: string, who = "owner") => h.request(path, as(who));
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
const codeOf = async (r: Response) => (await json<{ code: string }>(r)).code;
const daysFromToday = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function ownerIn<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result.rows;
  } finally {
    client.release();
  }
}

type Overview = {
  dspt: {
    status: string;
    financialYear: string;
    assertions: { total: number; metWithoutEvidence: number };
  };
  certificates: { kind: string; status: string; expiresOn: string | null }[];
  registers: { openBreaches: number; openComplaints: number };
};
type Assertion = {
  id: string;
  version: number;
  status: string;
  evidence: { documentId: string }[];
};

beforeAll(async () => {
  h = await createHarness();
  const docs = await ownerIn<{ id: string; person_id: string | null }>(
    `INSERT INTO document (category, title, retention_class, storage_key, content_type, size_bytes, sha256, person_id)
     VALUES ('organisation_document', 'Information security policy', 'organisation_document', 'dse-1', 'application/pdf', 10, $1, NULL),
            ('person_document', 'A letter', 'care_record', 'dse-2', 'application/pdf', 10, $1, $2)
     RETURNING id, person_id`,
    [HASH, LODGE.personId],
  );
  orgDocument = docs.find((d) => d.person_id === null)?.id ?? "";
  personDocument = docs.find((d) => d.person_id !== null)?.id ?? "";
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const overview = async () => json<Overview>(await get("/v1/data-security"));
const kind = (o: Overview, k: string) => o.certificates.find((c) => c.kind === k);

describe("QUAL-012 data security evidence", () => {
  it("is for holders of quality.dsar.manage across the organisation only", async () => {
    expect((await get("/v1/data-security", "owner")).status).toBe(200);
    expect((await get("/v1/data-security", "quality")).status).toBe(200);
    // The Registered Manager holds it for one home only.
    expect((await get("/v1/data-security", "manager")).status).toBe(403);
    expect((await get("/v1/data-security/certificates", "carer")).status).toBe(403);
  });

  it("says a certificate kind with no record is missing, never current, and works out each status", async () => {
    const before = await overview();
    expect(before.certificates.map((c) => c.status)).toEqual(["missing", "missing", "missing"]);
    const record = (body: object) => send("POST", "/v1/data-security/certificates", "owner", body);
    expect(
      (await record({ kind: "cyber_essentials", reference: "CE-1", issuedOn: daysFromToday(-400) }))
        .status,
    ).toBe(201);
    await record({ kind: "ico_registration", reference: "ZA123456", issuedOn: daysFromToday(-30) });
    await record({
      kind: "cyber_essentials_plus",
      reference: "CEP-1",
      issuedOn: daysFromToday(-355),
      expiresOn: daysFromToday(10),
    });
    // An ICO registration expiring the same day as the Plus certificate (each gets a task).
    await record({
      kind: "ico_registration",
      reference: "ZA654321",
      issuedOn: daysFromToday(-20),
      expiresOn: daysFromToday(10),
    });
    const after = await overview();
    expect(kind(after, "cyber_essentials")?.status).toBe("expired");
    expect(kind(after, "ico_registration")).toMatchObject({
      status: "due_soon",
      expiresOn: daysFromToday(10),
    });
    expect(kind(after, "cyber_essentials_plus")).toMatchObject({
      status: "due_soon",
      expiresOn: daysFromToday(10),
    });
    const future = await record({
      kind: "ico_registration",
      reference: "Z",
      issuedOn: daysFromToday(2),
    });
    expect(await codeOf(future)).toBe("date_in_future");
    const personCopy = await record({
      kind: "ico_registration",
      reference: "Z",
      issuedOn: daysFromToday(-1),
      documentId: personDocument,
    });
    expect(await codeOf(personCopy)).toBe("document_not_usable");
  });

  it("raises each renewal task once", async () => {
    const deps = {
      appDb: h.handle.services.db,
      workerPool: h.db.pool("harbour_worker"),
      logger: createLogger("silent"),
    };
    await remindDataSecurityRenewals(deps);
    await remindDataSecurityRenewals(deps);
    const tasks = await ownerIn<{ kind: string; source_type: string; n: string }>(
      `SELECT kind, source_type, count(*)::text AS n FROM task
        WHERE kind IN ('quality.certificate_renewal', 'quality.dspt_submission')
        GROUP BY kind, source_type`,
    );
    const renewals = tasks.find((t) => t.kind === "quality.certificate_renewal");
    // Cyber Essentials (expired), and Plus and the ICO registration, due soon on the same day.
    expect(renewals?.n).toBe("3");
    expect(tasks.every((t) => t.n !== "0")).toBe(true);
  });

  it("tracks assertions: met needs evidence, notes when not met, organisation documents only", async () => {
    const { dspt } = await overview();
    const created = await send("POST", "/v1/data-security/dspt/assertions", "quality", {
      financialYear: dspt.financialYear,
      assertionRef: "1.1.1",
      title: "Staff know their data security responsibilities",
    });
    expect(created.status).toBe(201);
    let a = await json<Assertion>(created);
    const again = await send("POST", "/v1/data-security/dspt/assertions", "quality", {
      financialYear: dspt.financialYear,
      assertionRef: "1.1.1",
      title: "Twice",
    });
    expect(await codeOf(again)).toBe("already_tracked");
    const status = (body: object) =>
      send("POST", `/v1/data-security/dspt/assertions/${a.id}/status`, "quality", body);
    expect(await codeOf(await status({ expectedVersion: a.version, status: "met" }))).toBe(
      "evidence_required",
    );
    expect(await codeOf(await status({ expectedVersion: a.version, status: "not_met" }))).toBe(
      "notes_required",
    );
    const link = (documentId: string) =>
      send("POST", `/v1/data-security/dspt/assertions/${a.id}/evidence`, "quality", { documentId });
    expect(await codeOf(await link(personDocument))).toBe("document_not_usable");
    a = await json<Assertion>(await link(orgDocument));
    expect(a.evidence.map((e) => e.documentId)).toEqual([orgDocument]);
    expect(await codeOf(await link(orgDocument))).toBe("already_linked");
    a = await json<Assertion>(await status({ expectedVersion: a.version, status: "met" }));
    expect(a.status).toBe("met");
    const stale = await status({ expectedVersion: 1, status: "in_progress" });
    expect(stale.status).toBe(409);
    const unlinked = await send(
      "POST",
      `/v1/data-security/dspt/assertions/${a.id}/evidence/${orgDocument}/unlink`,
      "quality",
    );
    expect((await json<Assertion>(unlinked)).evidence).toEqual([]);
    expect((await overview()).dspt.assertions.metWithoutEvidence).toBe(1);
  });

  it("records one DSPT submission per year, and the year is then no longer unsubmitted", async () => {
    const before = (await overview()).dspt;
    const body = {
      financialYear: before.financialYear,
      submittedOn: daysFromToday(0),
      // Earlier toolkit years published "standards exceeded" (H-917).
      outcome: "standards_exceeded",
      reference: "DSPT-REF-1",
    };
    const recorded = await send("POST", "/v1/data-security/dspt/submissions", "owner", body);
    expect(recorded.status).toBe(201);
    expect((await json<{ outcome: string }>(recorded)).outcome).toBe("standards_exceeded");
    expect(
      await codeOf(await send("POST", "/v1/data-security/dspt/submissions", "owner", body)),
    ).toBe("already_recorded");
    const after = (await overview()).dspt;
    expect(after.status === "submitted" || after.financialYear !== before.financialYear).toBe(true);
    const tooEarly = await send("POST", "/v1/data-security/dspt/submissions", "owner", {
      ...body,
      financialYear: "2099/00",
    });
    expect(await codeOf(tooEarly)).toBe("year_out_of_range");
  });

  it("audits with ids and codes only", async () => {
    const rows = await ownerIn<{ action: string; scope: unknown }>(
      "SELECT action, scope FROM audit_event WHERE action LIKE 'quality.data_security.%'",
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "quality.data_security.overview_viewed",
        "quality.data_security.certificate_recorded",
        "quality.data_security.evidence_linked",
        "quality.data_security.submission_recorded",
      ]),
    );
    expect(JSON.stringify(rows)).not.toMatch(/responsibilities|ZA123456|DSPT-REF-1|CE-1/);
  });
});
