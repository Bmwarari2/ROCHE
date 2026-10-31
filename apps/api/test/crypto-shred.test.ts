import { createHash } from "node:crypto";
import type {
  CertificateVerification,
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
import { outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Whole-organisation crypto-shredding (PLAT-012; platform.md, Crypto-shredding; ADR-0109): two
 * different people, each with a fresh step-up, after a downloaded export; a legal hold, an
 * expired request or a requester who can no longer manage retention refuses it; approval commits
 * before the keys are destroyed, and the worker completes a shred the API could not (security
 * review H1). Once shredded, the organisation's stored objects can no longer be read and the
 * signed certificate says what was destroyed, by whom and when. Another organisation is untouched.
 */

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const REASON = "The contract has ended and the full export was downloaded on 30 October.";
const json = async <T>(response: Response) => (await response.json()) as T;

function helpers(get: () => Harness) {
  const as = (
    user: keyof Harness["tokens"],
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) => get().request(path, { token: get().tokens[user], tenant: DEMO.tenantId, ...init });

  /** The owner pool in the demo organisation, as `userId` (the restrictive policies need one). */
  async function asDemoTenant<T>(
    fn: (c: pg.PoolClient) => Promise<T>,
    userId: string | null = null,
  ): Promise<T> {
    const client = await get().db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true),
                set_config('app.user_id', $2, true)`,
        [DEMO.tenantId, userId ?? ""],
      );
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** A full export the owner asked for, downloaded `daysAgo` days ago (null: never downloaded). */
  const exportDownloaded = (daysAgo: number | null) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO tenant_export (kind, status, requested_by, ready_at, downloaded_at, downloaded_by)
         VALUES ('full', 'expired', $1, now() - interval '40 days',
           CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(days => $2::int) END,
           CASE WHEN $2::int IS NULL THEN NULL ELSE $1::uuid END)
         RETURNING id`,
        [DEMO.users.owner.id, daysAgo],
      );
      return rows[0]?.id ?? "";
    });

  const ask = (user: keyof Harness["tokens"], exportId: string, reason = REASON) =>
    as(user, "/v1/retention/shred-requests", { method: "POST", body: { reason, exportId } });

  const audited = (action: string) =>
    asDemoTenant((c) =>
      c.query<{ outcome: string; reason: string | null; actor: string; scope: unknown }>(
        `SELECT outcome, reason, actor_tenant_user_id AS actor, scope FROM audit_event
         WHERE action = $1 ORDER BY seq`,
        [action],
      ),
    ).then((r) => r.rows);

  const uploadDocument = async () => {
    const uploaded = await get().request(
      `/v1/documents?${new URLSearchParams({ category: "organisation_document", title: "Fire safety policy" })}`,
      {
        token: get().tokens.manager,
        tenant: DEMO.tenantId,
        method: "POST",
        raw: { bytes: PDF, contentType: "application/pdf" },
      },
    );
    expect(uploaded.status).toBe(201);
    return json<DocumentItem>(uploaded);
  };

  return { as, asDemoTenant, exportDownloaded, ask, audited, uploadDocument };
}

describe("crypto-shredding an organisation", () => {
  let h: Harness;
  const { as, asDemoTenant, exportDownloaded, ask, audited, uploadDocument } = helpers(() => h);
  let document: DocumentItem;
  let exportId: string;
  const otherKey = `tenants/${OTHER.tenantId}/documents/0194e000-0000-7000-8000-0000000009d1`;

  beforeAll(async () => {
    h = await createHarness();
    document = await uploadDocument();
    exportId = await exportDownloaded(1);
    await h.handle.services.storage.put(otherKey, PDF, "application/pdf");
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it("stores documents encrypted and reads them back before any shred", async () => {
    const read = await as("manager", `/v1/documents/${document.id}/content`);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PDF);
  });

  it("refuses a short reason, an export not downloaded or too old, extra fields, and anyone without the permission", async () => {
    const short = await ask("owner", exportId, "Leaving");
    expect(short.status).toBe(422);
    expect((await json<ProblemDetails>(short)).code).toBe("reason_too_short");
    for (const notReady of [await exportDownloaded(null), await exportDownloaded(31)]) {
      const refused = await ask("owner", notReady);
      expect(refused.status).toBe(422);
      expect((await json<ProblemDetails>(refused)).code).toBe("export_not_downloaded");
    }
    const extra = await as("owner", "/v1/retention/shred-requests", {
      method: "POST",
      body: { reason: REASON, exportId, exportConfirmed: true },
    });
    expect(extra.status).toBe(422);
    expect((await ask("carer", exportId)).status).toBe(403);
    // A location-scoped Registered Manager is refused: the decision is tenant-wide.
    expect((await as("manager", "/v1/retention/shred-requests")).status).toBe(403);
    const refusals = await audited("platform.retention.shred_requested");
    expect(refusals.map((r) => [r.outcome, r.reason])).toEqual([
      ["denied", "reason_too_short"],
      ["denied", "export_not_downloaded"],
      ["denied", "export_not_downloaded"],
    ]);
  });

  it("refuses a request without a fresh step-up", async () => {
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const refused = await ask("owner", exportId);
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
        body: { subjectType: "document", subjectId: document.id, reason: "Solicitor's letter" },
      }),
    );
    const refused = await ask("owner", exportId);
    expect(refused.status).toBe(409);
    expect((await json<ProblemDetails>(refused)).code).toBe("legal_hold_active");
    const released = await as("owner", `/v1/legal-holds/${hold.id}/release`, {
      method: "POST",
      body: { reason: "Solicitor confirmed no claim", version: hold.version },
    });
    expect(released.status).toBe(200);
  });

  it("lets the requester cancel, and nobody else while it is fresh", async () => {
    const request = await json<ShredRequestItem>(await ask("owner", exportId));
    expect(request.status).toBe("pending");
    expect((await json<ProblemDetails>(await ask("quality", exportId))).code).toBe(
      "already_pending",
    );
    const notTheirs = await as("quality", `/v1/retention/shred-requests/${request.id}/cancel`, {
      method: "POST",
    });
    expect(notTheirs.status).toBe(403);
    const cancelled = await as("owner", `/v1/retention/shred-requests/${request.id}/cancel`, {
      method: "POST",
    });
    expect((await json<ShredRequestItem>(cancelled)).status).toBe("cancelled");
    const approveCancelled = await as(
      "quality",
      `/v1/retention/shred-requests/${request.id}/approve`,
      { method: "POST" },
    );
    expect((await json<ProblemDetails>(approveCancelled)).code).toBe("not_pending");
  });

  it("lets a request lapse after 7 days: it cannot be approved, and another holder may withdraw it", async () => {
    const request = await json<ShredRequestItem>(await ask("owner", exportId));
    // Backdated by the table's owner, with the guard set aside for the test only.
    await asDemoTenant(async (c) => {
      await c.query(
        "ALTER TABLE tenant_shred_request DISABLE TRIGGER tenant_shred_request_guard, NO FORCE ROW LEVEL SECURITY",
      );
      await c.query(
        "UPDATE tenant_shred_request SET requested_at = now() - interval '8 days' WHERE id = $1",
        [request.id],
      );
      await c.query(
        "ALTER TABLE tenant_shred_request ENABLE TRIGGER tenant_shred_request_guard, FORCE ROW LEVEL SECURITY",
      );
    }, DEMO.users.owner.id);
    const late = await as("quality", `/v1/retention/shred-requests/${request.id}/approve`, {
      method: "POST",
    });
    expect((await json<ProblemDetails>(late)).code).toBe("expired");
    // Shown as lapsed, and withdrawn rather than refused.
    const listed = await json<ShredRequestList>(await as("owner", "/v1/retention/shred-requests"));
    expect(listed.items.find((i) => i.id === request.id)).toMatchObject({
      status: "pending",
      lapsed: true,
    });
    const lateRefusal = await as("quality", `/v1/retention/shred-requests/${request.id}/refuse`, {
      method: "POST",
      body: { reason: "Not agreed by the board yet" },
    });
    expect((await json<ProblemDetails>(lateRefusal)).code).toBe("expired");
    const withdrawn = await as("quality", `/v1/retention/shred-requests/${request.id}/cancel`, {
      method: "POST",
    });
    expect(withdrawn.status).toBe(200);
  });

  it("refuses an approval once the requester can no longer manage retention", async () => {
    const request = await json<ShredRequestItem>(await ask("quality", exportId));
    await asDemoTenant(async (c) => {
      await c.query("UPDATE role_assignment SET valid_to = now() WHERE tenant_user_id = $1", [
        LODGE.qualityLeadId,
      ]);
    });
    try {
      const refused = await as("owner", `/v1/retention/shred-requests/${request.id}/approve`, {
        method: "POST",
      });
      expect((await json<ProblemDetails>(refused)).code).toBe("requester_ineligible");
    } finally {
      await asDemoTenant(async (c) => {
        await c.query("UPDATE role_assignment SET valid_to = NULL WHERE tenant_user_id = $1", [
          LODGE.qualityLeadId,
        ]);
      });
    }
    const cancelled = await as("quality", `/v1/retention/shred-requests/${request.id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
  });

  it("lets a second person refuse a request with a reason, finally, and never the requester (PLAT-012 part 2)", async () => {
    const request = await json<ShredRequestItem>(await ask("owner", exportId));
    expect(request).toMatchObject({ status: "pending", lapsed: false, decisionReason: null });
    expect(new Date(request.expiresAt).getTime() - new Date(request.requestedAt).getTime()).toBe(
      7 * 86_400_000,
    );
    const refuse = (user: "owner" | "quality", reason: string) =>
      as(user, `/v1/retention/shred-requests/${request.id}/refuse`, {
        method: "POST",
        body: { reason },
      });
    const self = await refuse("owner", "Not agreed by the board yet");
    expect(self.status).toBe(403);
    expect((await json<ProblemDetails>(self)).code).toBe("same_person");
    const short = await refuse("quality", "No");
    expect(short.status).toBe(422);
    expect((await json<ProblemDetails>(short)).code).toBe("reason_too_short");
    expect(
      (
        await as("manager", `/v1/retention/shred-requests/${request.id}/refuse`, {
          method: "POST",
          body: { reason: "Not agreed by the board yet" },
        })
      ).status,
    ).toBe(403);
    const refused = await refuse("quality", "Not agreed by the board yet");
    expect(refused.status).toBe(200);
    expect(await json<ShredRequestItem>(refused)).toMatchObject({
      status: "refused",
      decidedBy: LODGE.qualityLeadId,
      decisionReason: "Not agreed by the board yet",
      lapsed: false,
    });
    const again = await refuse("quality", "Not agreed by the board yet");
    expect(again.status).toBe(409);
    expect((await json<ProblemDetails>(again)).code).toBe("not_pending");
    const approve = await as("quality", `/v1/retention/shred-requests/${request.id}/approve`, {
      method: "POST",
    });
    expect((await json<ProblemDetails>(approve)).code).toBe("not_pending");
    const audit = await audited("platform.retention.shred_refused");
    expect(audit.map((a) => a.outcome)).toEqual(expect.arrayContaining(["denied", "success"]));
    // The reason is on the request, never in the audit.
    for (const a of audit) expect(JSON.stringify(a)).not.toContain("board");
  });

  let requestId: string;

  it("refuses the requester as approver, and an approval under a legal hold", async () => {
    requestId = (await json<ShredRequestItem>(await ask("owner", exportId))).id;
    const self = await as("owner", `/v1/retention/shred-requests/${requestId}/approve`, {
      method: "POST",
    });
    expect(self.status).toBe(403);
    expect((await json<ProblemDetails>(self)).code).toBe("same_person");
    const hold = await json<LegalHoldItem>(
      await as("owner", "/v1/legal-holds", {
        method: "POST",
        body: { subjectType: "document", subjectId: document.id, reason: "Insurer has asked" },
      }),
    );
    const held = await as("quality", `/v1/retention/shred-requests/${requestId}/approve`, {
      method: "POST",
    });
    expect((await json<ProblemDetails>(held)).code).toBe("legal_hold_active");
    await as("owner", `/v1/legal-holds/${hold.id}/release`, {
      method: "POST",
      body: { reason: "Insurer withdrew the request", version: hold.version },
    });
    expect((await as("manager", `/v1/documents/${document.id}/content`)).status).toBe(200);
  });

  let approved: ShredApproved;

  it("shreds on a second person's approval, with a signed certificate", async () => {
    const response = await as("quality", `/v1/retention/shred-requests/${requestId}/approve`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    approved = await json<ShredApproved>(response);
    const { request } = approved;
    const certificate = approved.certificate;
    if (!certificate) throw new Error("no certificate");
    expect(request).toMatchObject({
      status: "approved",
      requestedBy: DEMO.users.owner.id,
      decidedBy: LODGE.qualityLeadId,
      certificateId: certificate.id,
    });
    expect(certificate).toMatchObject({
      tenantId: DEMO.tenantId,
      subjectType: "tenant",
      subjectIds: [DEMO.tenantId],
      method: "kms_key_destroy:local",
      requestedBy: DEMO.users.owner.id,
      approvedBy: LODGE.qualityLeadId,
      signatureKey: "local/certificate-signing/1",
      signatureAlgorithm: "ED25519",
      reason: REASON,
      retentionRule: expect.objectContaining({ exportId }),
    });
    expect(certificate.keyVersions.length).toBeGreaterThan(0);
    expect(certificate.recordCount).toBe(certificate.keyVersions.length);
    expect(certificate.keysDestroyedAt).not.toBeNull();
    // Backups expire after the longer of the recovery window and backup retention (7 here).
    const executed = new Date(certificate.executedAt).getTime();
    expect(new Date(certificate.backupsExpireAt ?? 0).getTime() - executed).toBe(7 * 86_400_000);

    // The response holds every field of the signed body: anyone can rebuild and check it.
    const body = certificateBody({
      ...certificate,
      executedAt: new Date(certificate.executedAt),
      backupsExpireAt: certificate.backupsExpireAt ? new Date(certificate.backupsExpireAt) : null,
    });
    expect(createHash("sha256").update(body).digest("hex")).toBe(certificate.bodySha256);
    const { tenantKeys } = h.handle.services;
    const message = Buffer.from(body, "utf8");
    const key = certificate.signatureKey ?? "";
    expect(await tenantKeys.verify(message, certificate.signature ?? "", key)).toBe(true);
    const tampered = Buffer.from(body.replace(REASON, `${REASON} `), "utf8");
    expect(await tenantKeys.verify(tampered, certificate.signature ?? "", key)).toBe(false);
    // Only Harbour's own certificate key is trusted, whatever a row names.
    expect(await tenantKeys.verify(message, certificate.signature ?? "", "attacker/key/1")).toBe(
      false,
    );
    // Opaque ids only: no names or emails on the certificate.
    expect(body).not.toContain(DEMO.users.owner.name);
    expect(body).not.toContain("@");

    const verification = await json<CertificateVerification>(
      await as("owner", `/v1/destruction-certificates/${certificate.id}/verification`),
    );
    expect(verification).toMatchObject({ valid: true, body });
  });

  it("opens one certificate and downloads it as a PDF, built on request, audited (PLAT-012 part 2)", async () => {
    const certificate = approved.certificate;
    if (!certificate) throw new Error("no certificate");
    const one = await as("owner", `/v1/destruction-certificates/${certificate.id}`);
    expect(one.status).toBe(200);
    expect(await json<unknown>(one)).toEqual(certificate);
    const pdf = await as("owner", `/v1/destruction-certificates/${certificate.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("cache-control")).toBe("no-store");
    expect(pdf.headers.get("content-disposition")).toBe(
      `attachment; filename="destruction-certificate-${certificate.id}.pdf"`,
    );
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const downloads = await audited("platform.destruction_certificate.download");
    expect(downloads.at(-1)).toMatchObject({ outcome: "success", actor: DEMO.users.owner.id });
    expect((await as("manager", `/v1/destruction-certificates/${certificate.id}/pdf`)).status).toBe(
      403,
    );
    const missing = "0194e000-0000-7000-8000-00000000dead";
    expect((await as("owner", `/v1/destruction-certificates/${missing}`)).status).toBe(404);
    expect((await as("owner", `/v1/destruction-certificates/${missing}/pdf`)).status).toBe(404);
  });

  it("refuses every read and write of the organisation's stored objects, and new holds, afterwards", async () => {
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
    const hold = await as("owner", "/v1/legal-holds", {
      method: "POST",
      body: { subjectType: "document", subjectId: document.id, reason: "Too late to hold" },
    });
    expect(hold.status).toBe(409);
    expect((await json<ProblemDetails>(hold)).code).toBe("shred_under_way");
  });

  it("leaves another organisation's objects readable", async () => {
    const back = await h.handle.services.storage.get(otherKey);
    expect(back && new Uint8Array(back)).toEqual(PDF);
  });

  it("lists the requests and audits both people's steps", async () => {
    const list = await json<ShredRequestList>(await as("quality", "/v1/retention/shred-requests"));
    expect(list.items.map((i) => i.status).sort()).toEqual([
      "approved",
      "cancelled",
      "cancelled",
      "cancelled",
      "refused",
    ]);
    const decided = await audited("platform.retention.shred_approved");
    expect(decided.map((r) => [r.outcome, r.reason])).toEqual([
      ["denied", "not_pending"],
      ["denied", "expired"],
      ["denied", "requester_ineligible"],
      // The approval tried on a refused request.
      ["denied", "not_pending"],
      ["denied", "same_person"],
      ["denied", "legal_hold_active"],
      ["success", null],
    ]);
    const completed = await audited("platform.retention.shred_completed");
    expect(completed).toEqual([
      expect.objectContaining({
        outcome: "success",
        actor: LODGE.qualityLeadId,
        scope: expect.objectContaining({ certificateId: approved.certificate?.id }),
      }),
    ]);
  });
});

describe("a shred the API cannot finish (security review H1)", () => {
  let h: Harness;
  const { as, exportDownloaded, ask, audited, uploadDocument } = helpers(() => h);

  beforeAll(async () => {
    h = await createHarness();
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it("commits the approval first, refuses a cancel and new holds, and the worker completes it", async () => {
    const document = await uploadDocument();
    const exportId = await exportDownloaded(0);
    const request = await json<ShredRequestItem>(await ask("owner", exportId));
    const keys = h.handle.services.tenantKeys;
    const sign = keys.sign.bind(keys);
    // The certificate key is unreachable: the keys are destroyed, but nothing can be signed.
    keys.sign = () => Promise.reject(new Error("signing unavailable"));
    let response: Response;
    try {
      response = await as("quality", `/v1/retention/shred-requests/${request.id}/approve`, {
        method: "POST",
      });
    } finally {
      keys.sign = sign;
    }
    expect(response.status).toBe(202);
    const pending = await json<ShredApproved>(response);
    expect(pending).toMatchObject({ request: { status: "shredding" }, certificate: null });
    expect((await audited("platform.retention.shred_approved")).map((r) => r.outcome)).toEqual([
      "success",
    ]);

    expect((await as("manager", `/v1/documents/${document.id}/content`)).status).toBe(410);
    const cancel = await as("owner", `/v1/retention/shred-requests/${request.id}/cancel`, {
      method: "POST",
    });
    expect((await json<ProblemDetails>(cancel)).code).toBe("not_pending");
    const hold = await as("owner", "/v1/legal-holds", {
      method: "POST",
      body: { subjectType: "document", subjectId: document.id, reason: "Placed after approval" },
    });
    expect((await json<ProblemDetails>(hold)).code).toBe("shred_under_way");

    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: h.handle.services.db,
      logger: createLogger("silent"),
      tenantKeys: keys,
      dataKeyCache: h.handle.services.dataKeyCache,
      backupDays: 7,
    };
    await relayOutbox(deps, outboxHandlers(deps));
    const list = await json<ShredRequestList>(await as("quality", "/v1/retention/shred-requests"));
    const done = list.items.find((i) => i.id === request.id);
    expect(done).toMatchObject({ status: "approved", decidedBy: LODGE.qualityLeadId });
    expect(done?.certificateId).toEqual(expect.any(String));
    const verification = await json<CertificateVerification>(
      await as("owner", `/v1/destruction-certificates/${done?.certificateId}/verification`),
    );
    expect(verification.valid).toBe(true);
    expect(await audited("platform.retention.shred_completed")).toHaveLength(1);
    // Relayed again (at-least-once delivery): nothing more is issued.
    await relayOutbox(deps, outboxHandlers(deps));
    expect(await audited("platform.retention.shred_completed")).toHaveLength(1);
  });
});
