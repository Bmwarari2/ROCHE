import { createHash } from "node:crypto";
import type {
  DocumentItem,
  LegalHoldItem,
  ProblemDetails,
  ShredApproved,
  ShredRequestItem,
  ShredRequestList,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { certificateBody } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness, OTHER } from "./support/harness";

/**
 * Whole-organisation crypto-shredding (PLAT-012; platform.md, Crypto-shredding; ADR-0109): two
 * different people, each with a fresh step-up; a legal hold refuses it; once approved, the
 * organisation's stored objects can no longer be read, and the signed certificate says what was
 * destroyed, by whom and when. Another organisation is untouched. The shred runs last: it ends
 * the demo organisation's storage for the rest of this file.
 */

let h: Harness;

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const REASON = "The contract has ended and the full export was taken on 30 October.";
const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });

async function asDemoTenant<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

const audited = (action: string) =>
  asDemoTenant((c) =>
    c.query<{ outcome: string; reason: string | null; actor: string; scope: unknown }>(
      `SELECT outcome, reason, actor_tenant_user_id AS actor, scope FROM audit_event
       WHERE action = $1 ORDER BY seq`,
      [action],
    ),
  ).then((r) => r.rows);

let document: DocumentItem;
const otherKey = `tenants/${OTHER.tenantId}/documents/0194e000-0000-7000-8000-0000000009d1`;

beforeAll(async () => {
  h = await createHarness();
  const uploaded = await h.request(
    `/v1/documents?${new URLSearchParams({ category: "organisation_document", title: "Fire safety policy" })}`,
    {
      token: h.tokens.manager,
      tenant: DEMO.tenantId,
      method: "POST",
      raw: { bytes: PDF, contentType: "application/pdf" },
    },
  );
  expect(uploaded.status).toBe(201);
  document = await json<DocumentItem>(uploaded);
  await h.handle.services.storage.put(otherKey, PDF, "application/pdf");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("crypto-shredding an organisation", () => {
  it("stores documents encrypted and reads them back before any shred", async () => {
    const read = await as("manager", `/v1/documents/${document.id}/content`);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PDF);
  });

  it("refuses a short reason, a missing export confirmation and anyone without the permission", async () => {
    const short = await as("owner", "/v1/retention/shred-requests", {
      method: "POST",
      body: { reason: "Leaving", exportConfirmed: true },
    });
    expect(short.status).toBe(422);
    expect((await json<ProblemDetails>(short)).code).toBe("reason_too_short");
    const noExport = await as("owner", "/v1/retention/shred-requests", {
      method: "POST",
      body: { reason: REASON, exportConfirmed: false },
    });
    expect((await json<ProblemDetails>(noExport)).code).toBe("export_not_confirmed");
    const carer = await as("carer", "/v1/retention/shred-requests", {
      method: "POST",
      body: { reason: REASON, exportConfirmed: true },
    });
    expect(carer.status).toBe(403);
    // A location-scoped Registered Manager is refused: the decision is tenant-wide.
    const manager = await as("manager", "/v1/retention/shred-requests");
    expect(manager.status).toBe(403);
    const refusals = await audited("platform.retention.shred_requested");
    expect(refusals.map((r) => [r.outcome, r.reason])).toEqual([
      ["denied", "reason_too_short"],
      ["denied", "export_not_confirmed"],
    ]);
  });

  it("refuses a request without a fresh step-up", async () => {
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const refused = await as("owner", "/v1/retention/shred-requests", {
        method: "POST",
        body: { reason: REASON, exportConfirmed: true },
      });
      expect(refused.status).toBe(403);
      expect((await json<ProblemDetails>(refused)).code).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
  });

  it("refuses a request while a legal hold is active", async () => {
    const hold = await json<LegalHoldItem>(
      await as("owner", "/v1/legal-holds", {
        method: "POST",
        body: {
          subjectType: "document",
          subjectId: document.id,
          reason: "Solicitor's letter received",
        },
      }),
    );
    const refused = await as("owner", "/v1/retention/shred-requests", {
      method: "POST",
      body: { reason: REASON, exportConfirmed: true },
    });
    expect(refused.status).toBe(409);
    expect((await json<ProblemDetails>(refused)).code).toBe("legal_hold_active");
    const released = await as("owner", `/v1/legal-holds/${hold.id}/release`, {
      method: "POST",
      body: { reason: "Solicitor confirmed no claim", version: hold.version },
    });
    expect(released.status).toBe(200);
  });

  let requestId: string;

  it("lets the requester cancel, and nobody else", async () => {
    const asked = await as("owner", "/v1/retention/shred-requests", {
      method: "POST",
      body: { reason: REASON, exportConfirmed: true },
    });
    expect(asked.status).toBe(201);
    const request = await json<ShredRequestItem>(asked);
    const again = await as("quality", "/v1/retention/shred-requests", {
      method: "POST",
      body: { reason: REASON, exportConfirmed: true },
    });
    expect((await json<ProblemDetails>(again)).code).toBe("already_pending");
    const notTheirs = await as("quality", `/v1/retention/shred-requests/${request.id}/cancel`, {
      method: "POST",
    });
    expect(notTheirs.status).toBe(403);
    const cancelled = await as("owner", `/v1/retention/shred-requests/${request.id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
    expect((await json<ShredRequestItem>(cancelled)).status).toBe("cancelled");
    const approveCancelled = await as(
      "quality",
      `/v1/retention/shred-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect((await json<ProblemDetails>(approveCancelled)).code).toBe("not_pending");
  });

  it("refuses the requester as approver", async () => {
    const asked = await as("owner", "/v1/retention/shred-requests", {
      method: "POST",
      body: { reason: REASON, exportConfirmed: true },
    });
    requestId = (await json<ShredRequestItem>(asked)).id;
    const self = await as("owner", `/v1/retention/shred-requests/${requestId}/approve`, {
      method: "POST",
    });
    expect(self.status).toBe(403);
    expect((await json<ProblemDetails>(self)).code).toBe("same_person");
    const read = await as("manager", `/v1/documents/${document.id}/content`);
    expect(read.status).toBe(200);
  });

  it("refuses an approval while a legal hold is active", async () => {
    const hold = await json<LegalHoldItem>(
      await as("owner", "/v1/legal-holds", {
        method: "POST",
        body: {
          subjectType: "document",
          subjectId: document.id,
          reason: "Insurer has asked for it",
        },
      }),
    );
    const refused = await as("quality", `/v1/retention/shred-requests/${requestId}/approve`, {
      method: "POST",
    });
    expect((await json<ProblemDetails>(refused)).code).toBe("legal_hold_active");
    await as("owner", `/v1/legal-holds/${hold.id}/release`, {
      method: "POST",
      body: { reason: "Insurer withdrew the request", version: hold.version },
    });
  });

  let approved: ShredApproved;

  it("shreds on a second person's approval, with a signed certificate", async () => {
    const response = await as("quality", `/v1/retention/shred-requests/${requestId}/approve`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    approved = await json<ShredApproved>(response);
    const { request, certificate } = approved;
    expect(request).toMatchObject({
      status: "approved",
      requestedBy: DEMO.users.owner.id,
      decidedBy: expect.any(String),
      certificateId: certificate.id,
    });
    expect(request.decidedBy).not.toBe(DEMO.users.owner.id);
    expect(certificate).toMatchObject({
      subjectType: "tenant",
      method: "kms_key_destroy:local",
      requestedBy: DEMO.users.owner.id,
      approvedBy: request.decidedBy,
      signatureAlgorithm: "ED25519",
      reason: REASON,
    });
    expect(certificate.keyVersions.length).toBeGreaterThan(0);
    expect(certificate.recordCount).toBe(certificate.keyVersions.length);
    expect(certificate.keysDestroyedAt).not.toBeNull();
    // Backups expire after the point-in-time recovery window (DATABASE_PITR_DAYS, 7 by default).
    const executed = new Date(certificate.executedAt).getTime();
    expect(new Date(certificate.backupsExpireAt ?? 0).getTime() - executed).toBe(7 * 86_400_000);
    expect(certificate.bodySha256).toMatch(/^[0-9a-f]{64}$/);

    // The certificate, rebuilt into its canonical body, matches the stored hash and verifies
    // against the certificate key.
    const body = certificateBody({
      id: certificate.id,
      tenantId: DEMO.tenantId,
      recordClass: certificate.recordClass,
      subjectType: certificate.subjectType,
      subjectIds: [DEMO.tenantId],
      recordCount: certificate.recordCount,
      retentionRule: { trigger: "tenant_exit", source: "retention-and-deletion.md" },
      reason: certificate.reason,
      method: certificate.method,
      executedAt: new Date(certificate.executedAt),
      requestedBy: certificate.requestedBy,
      approvedBy: certificate.approvedBy,
      keyVersions: certificate.keyVersions,
      backupsExpireAt: certificate.backupsExpireAt ? new Date(certificate.backupsExpireAt) : null,
    });
    const row = await asDemoTenant((c) =>
      c.query<{ body_sha256: string }>(
        "SELECT body_sha256 FROM destruction_certificate WHERE id = $1",
        [certificate.id],
      ),
    );
    expect(row.rows[0]?.body_sha256).toBe(createHash("sha256").update(body).digest("hex"));
    const { tenantKeys } = h.handle.services;
    const message = Buffer.from(body, "utf8");
    const key = certificate.signatureKey ?? "";
    expect(await tenantKeys.verify(message, certificate.signature ?? "", key)).toBe(true);
    // A changed field no longer verifies.
    const tampered = Buffer.from(body.replace(REASON, `${REASON} `), "utf8");
    expect(await tenantKeys.verify(tampered, certificate.signature ?? "", key)).toBe(false);
    // Opaque ids only: no names or emails on the certificate.
    expect(body).not.toContain(DEMO.users.owner.name);
    expect(body).not.toContain("@");
  });

  it("refuses every read of the organisation's stored objects afterwards", async () => {
    const read = await as("manager", `/v1/documents/${document.id}/content`);
    expect(read.status).toBe(410);
    expect((await json<ProblemDetails>(read)).code).toBe("shredded");
    const write = await h.request(
      `/v1/documents?${new URLSearchParams({ category: "organisation_document", title: "Late upload" })}`,
      {
        token: h.tokens.manager,
        tenant: DEMO.tenantId,
        method: "POST",
        raw: { bytes: PDF, contentType: "application/pdf" },
      },
    );
    expect(write.status).toBe(410);
  });

  it("leaves another organisation's objects readable", async () => {
    const back = await h.handle.services.storage.get(otherKey);
    expect(back && new Uint8Array(back)).toEqual(PDF);
  });

  it("lists the request and audits both people's steps", async () => {
    const list = await json<ShredRequestList>(await as("quality", "/v1/retention/shred-requests"));
    expect(list.items.map((i) => i.status).sort()).toEqual(["approved", "cancelled"]);
    const asked = await audited("platform.retention.shred_requested");
    expect(asked.filter((r) => r.outcome === "success").map((r) => r.actor)).toEqual([
      DEMO.users.owner.id,
      DEMO.users.owner.id,
    ]);
    const decided = await audited("platform.retention.shred_approved");
    expect(decided.map((r) => [r.outcome, r.reason])).toEqual([
      ["denied", "not_pending"],
      ["denied", "same_person"],
      ["denied", "legal_hold_active"],
      ["success", null],
    ]);
    expect(decided.at(-1)?.scope).toMatchObject({ certificateId: approved.certificate.id });
    expect((await audited("platform.retention.shred_cancelled")).map((r) => r.outcome)).toEqual([
      "denied",
      "success",
    ]);
  });
});
