import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The DPIA in-app (PLAT-023; platform-completions.md rules 17 to 22; section 5.1): prepared by a
 * holder of platform.dpia.prepare, signed only by the named data protection lead, who prepared
 * none of it, with step-up and a typed name bound to the version read; signed versions never
 * change; nothing crosses organisations. Every write is audited.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (who: string, tenant: string = DEMO.tenantId) => ({ token: h.tokens[who], tenant });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

type Version = {
  id: string;
  status: string;
  version: number;
  versionSha256: string | null;
  prefill: { sections: { key: string; tenantFields: string[] }[]; risks: { id: string }[] };
};
type Overview = {
  state: string;
  missingConfig: string[];
  open: Version | null;
  signed: Version | null;
  settings: { version: number; leadId: string | null };
};

/** Runs `fn` as the application role, as `member` of `tenant`, rolled back after. */
async function asApp<T>(
  member: string,
  fn: (q: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }>) => Promise<T>,
  tenant: string = DEMO.tenantId,
): Promise<T> {
  const client = await h.db.pool("harbour_app").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.scope', 'tenant', true)`,
      [tenant, member],
    );
    return await fn((text, values) => client.query(text, values));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Reads as the owner role within the organisation. */
async function asOwner<R extends Record<string, unknown>>(text: string, values: unknown[]) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    return (await client.query<R>(text, values)).rows;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const overview = async (who = "owner") =>
  (await (await h.request("/v1/dpia", as(who))).json()) as Overview;

/** Every tenant field answered and every risk rated, from the prefill. */
function complete(prefill: Version["prefill"]) {
  return {
    answers: Object.fromEntries(
      prefill.sections.map((s) => [
        s.key,
        Object.fromEntries(s.tenantFields.map((f) => [f, `Answered for ${f}`])),
      ]),
    ),
    residualRisk: Object.fromEntries(prefill.risks.map((r) => [r.id, "low"])),
    icoReference: null,
  };
}

const settings = {
  leadId: LODGE.qualityLeadId,
  dpoName: "Dee Example",
  dpoEmail: "dpo@example.invalid",
  sector: "independent",
  privacyNoticeUrl: "https://harbour.example.invalid/privacy",
  dpaSignedOn: "2026-09-01",
  usesDataBeyondDirectCare: false,
  marketingEnabled: false,
  aiFreeTextEnabled: false,
  aiProvider: null,
};

describe("hazard HZ-011 the DPIA, prepared and signed in-app", () => {
  it("starts not started, listing the configuration it still needs", async () => {
    const first = await overview();
    expect(first.state).toBe("not_started");
    expect(first.missingConfig).toEqual(
      expect.arrayContaining(["tenant.dpo", "tenant.dpaSignedOn", "tenant.privacyNoticeUrl"]),
    );
  });

  it("lets only platform.tenant.manage name the lead and set the governance", async () => {
    const save = async (who: string, body: Record<string, unknown>) =>
      send("PUT", "/v1/settings/data-protection", who, {
        ...settings,
        expectedVersion: (await overview()).settings.version,
        ...body,
      });
    expect((await save("manager", {})).status).toBe(403);
    // The CQC provider ID is set when the operator provisions the organisation.
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
      await client.query("UPDATE tenant SET cqc_provider_id = '1-000000999' WHERE id = $1", [
        DEMO.tenantId,
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const saved = await save("owner", {});
    expect(saved.status).toBe(200);
    expect((await overview()).missingConfig).toEqual([]);
    // Another organisation's member, or one whose role cannot sign the DPIA, is never the lead.
    expect((await save("owner", { leadId: OTHER.managerId })).status).toBe(422);
    expect((await save("owner", { leadId: DEMO.users.manager.id })).status).toBe(422);
    // A stale save is refused.
    const { version } = (await overview()).settings;
    expect(
      (
        await send("PUT", "/v1/settings/data-protection", "owner", {
          ...settings,
          expectedVersion: version - 1,
        })
      ).status,
    ).toBe(409);
  });

  it("needs step-up to name a different lead, and tells the one replaced", async () => {
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      // Other settings save without step-up; a different lead does not.
      const plain = await send("PUT", "/v1/settings/data-protection", "owner", {
        ...settings,
        dpoName: "Dee Example-Smith",
        expectedVersion: (await overview()).settings.version,
      });
      expect(plain.status).toBe(200);
      const refused = await send("PUT", "/v1/settings/data-protection", "owner", {
        ...settings,
        leadId: DEMO.users.owner.id,
        expectedVersion: (await overview()).settings.version,
      });
      expect(refused.status).toBe(403);
      expect(await codeOf(refused)).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
    for (const leadId of [DEMO.users.owner.id, LODGE.qualityLeadId]) {
      const changed = await send("PUT", "/v1/settings/data-protection", "owner", {
        ...settings,
        leadId,
        expectedVersion: (await overview()).settings.version,
      });
      expect(changed.status).toBe(200);
    }
    const told = await asOwner<{ recipient_tenant_user_id: string; body: string }>(
      `SELECT recipient_tenant_user_id, body FROM notification
        WHERE kind = 'platform.data_protection.lead_replaced' ORDER BY created_at`,
      [],
    );
    expect(told.map((n) => n.recipient_tenant_user_id)).toEqual([
      LODGE.qualityLeadId,
      DEMO.users.owner.id,
    ]);
    const audits = await asOwner<{ scope: { previousLeadId?: string; leadId?: string } }>(
      `SELECT scope FROM audit_event WHERE action = 'platform.data_protection.updated'
          AND outcome = 'success' AND scope ? 'previousLeadId' ORDER BY seq`,
      [],
    );
    expect(audits.at(-1)?.scope).toMatchObject({
      previousLeadId: DEMO.users.owner.id,
      leadId: LODGE.qualityLeadId,
    });
  });

  it("refuses governance changes at the database without platform.tenant.manage", async () => {
    await asApp(DEMO.users.manager.id, async (q) => {
      await expect(
        q("UPDATE tenant SET data_protection_lead_id = $1 WHERE id = $2", [
          DEMO.users.manager.id,
          DEMO.tenantId,
        ]),
      ).rejects.toThrow(/platform.tenant.manage/);
    });
    await asApp(DEMO.users.manager.id, async (q) => {
      await expect(
        q("UPDATE tenant SET marketing_enabled = true WHERE id = $1", [DEMO.tenantId]),
      ).rejects.toThrow(/platform.tenant.manage/);
    });
    // Even the holder cannot name a lead who may not sign.
    await asApp(DEMO.users.owner.id, async (q) => {
      await expect(
        q("UPDATE tenant SET data_protection_lead_id = $1 WHERE id = $2", [
          DEMO.users.manager.id,
          DEMO.tenantId,
        ]),
      ).rejects.toThrow(/may sign the DPIA/);
    });
  });

  it("has the manager prepare it, and refuses a stale save", async () => {
    const saved = await send("PUT", "/v1/dpia/draft", "manager", {
      ...complete({ sections: [], risks: [] }),
    });
    expect(saved.status).toBe(200);
    const draft = (await saved.json()) as Version;
    expect(
      (
        await send("PUT", "/v1/dpia/draft", "manager", {
          expectedVersion: draft.version - 1,
          ...complete(draft.prefill),
        })
      ).status,
    ).toBe(409);
    const filled = (await (
      await send("PUT", "/v1/dpia/draft", "manager", {
        expectedVersion: draft.version,
        ...complete(draft.prefill),
      })
    ).json()) as Version;
    const prepared = await send("POST", "/v1/dpia/draft/prepare", "manager", {
      expectedVersion: filled.version,
    });
    expect(prepared.status).toBe(200);
    const body = (await prepared.json()) as Version;
    expect(body.status).toBe("prepared");
    expect(body.versionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await overview()).state).toBe("prepared");
  });

  it.each([
    ["the owner, who is not the named lead", "owner", "sha", "not_designated_lead"],
    ["the lead, with a version they did not read", "quality", "other", "document_changed"],
    ["the manager, who prepared it and holds no sign permission", "manager", "sha", "403"],
  ] as const)("refuses %s", async (_, who, sha, expected) => {
    const { open } = await overview();
    const response = await send("POST", `/v1/dpia/${open?.id}/sign`, who, {
      typedName: "Quinn Quality",
      sha256Seen: sha === "sha" ? open?.versionSha256 : "0".repeat(64),
    });
    if (expected === "403") {
      expect(response.status).toBe(403);
      return;
    }
    expect(response.status).toBe(422);
    const problem = (await response.json()) as { code: string; detail: string };
    expect(problem.code).toBe("dpia_not_signable");
    expect(problem.detail.length).toBeGreaterThan(10);
  });

  it("needs a fresh step-up to sign", async () => {
    const { open } = await overview();
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.quality?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const response = await send("POST", `/v1/dpia/${open?.id}/sign`, "quality", {
        typedName: "Quinn Quality",
        sha256Seen: open?.versionSha256,
      });
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
  });

  it("is signed by the named lead, audited, and never changes after", async () => {
    const { open } = await overview();
    const signed = await send("POST", `/v1/dpia/${open?.id}/sign`, "quality", {
      typedName: "Quinn Quality",
      sha256Seen: open?.versionSha256,
    });
    expect(signed.status).toBe(200);
    const after = await overview();
    expect(after.state).toBe("signed");
    expect(after.signed?.id).toBe(open?.id);

    const client = await h.db.pool("harbour_app").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.scope', 'tenant', true)`,
        [DEMO.tenantId, DEMO.users.owner.id],
      );
      await expect(
        client.query(`UPDATE dpia SET answers = '{}'::jsonb WHERE id = $1`, [open?.id]),
      ).rejects.toThrow(/never changes/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const reader = await h.db.pool("harbour_owner").connect();
    let audits: { rows: { action: string }[] };
    try {
      await reader.query("BEGIN");
      await reader.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
      audits = await reader.query("SELECT action FROM audit_event WHERE resource_id = $1", [
        open?.id,
      ]);
      await reader.query("COMMIT");
    } finally {
      reader.release();
    }
    expect(audits.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "platform.dpia.saved",
        "platform.dpia.prepared",
        "platform.dpia.signed",
      ]),
    );
  });

  it("refuses at the database a sign by anyone but the lead, or a supersede with no successor", async () => {
    const { signed } = await overview();
    // The owner holds platform.dpia.sign but is not the named lead.
    await asApp(DEMO.users.owner.id, async (q) => {
      await expect(
        q(`UPDATE dpia SET status = 'superseded' WHERE id = $1`, [signed?.id]),
      ).rejects.toThrow(/never changes/);
    });
    // The lead cannot supersede the version in force without signing a later one.
    await expect(
      asApp(LODGE.qualityLeadId, async (q) => {
        await q(`UPDATE dpia SET status = 'superseded' WHERE id = $1`, [signed?.id]);
        await q("SET CONSTRAINTS ALL IMMEDIATE");
      }),
    ).rejects.toThrow(/never changes|superseded only by signing/);
  });

  it("supersedes the version in force when a later one is signed", async () => {
    const first = (await overview()).signed;
    const draft = (await (
      await send(
        "PUT",
        "/v1/dpia/draft",
        "manager",
        complete(first?.prefill ?? { sections: [], risks: [] }),
      )
    ).json()) as Version;
    await send("POST", "/v1/dpia/draft/prepare", "manager", { expectedVersion: draft.version });
    const { open } = await overview();
    // The lead may supersede only as the first step of signing the later version: at commit the
    // later version must be signed.
    await asApp(LODGE.qualityLeadId, async (q) => {
      await q(`UPDATE dpia SET status = 'superseded' WHERE id = $1`, [first?.id]);
      await expect(q("SET CONSTRAINTS dpia_superseded_by_signed IMMEDIATE")).rejects.toThrow(
        /superseded only by signing/,
      );
    });
    // Signing directly, without the typed name and statement, is refused at the database.
    await asApp(LODGE.qualityLeadId, async (q) => {
      await q(`UPDATE dpia SET status = 'superseded' WHERE id = $1`, [first?.id]);
      await expect(
        q(`UPDATE dpia SET status = 'signed', signed_by = $2, signed_at = now() WHERE id = $1`, [
          open?.id,
          LODGE.qualityLeadId,
        ]),
      ).rejects.toThrow(/signed, unchanged/);
    });
    const signed = await send("POST", `/v1/dpia/${open?.id}/sign`, "quality", {
      typedName: "Quinn Quality",
      sha256Seen: open?.versionSha256,
    });
    expect(signed.status).toBe(200);
    const after = await overview();
    expect(after.signed?.id).toBe(open?.id);
    const rows = await asOwner<{ id: string; status: string }>(
      "SELECT id, status FROM dpia WHERE id = ANY($1::uuid[])",
      [[first?.id, open?.id]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [first?.id ?? ""]: "superseded",
      [open?.id ?? ""]: "signed",
    });
  });

  it("refuses the lead signing a version they helped prepare", async () => {
    const started = (await (
      await send(
        "PUT",
        "/v1/dpia/draft",
        "quality",
        complete((await overview()).signed?.prefill ?? { sections: [], risks: [] }),
      )
    ).json()) as Version;
    await send("POST", "/v1/dpia/draft/prepare", "quality", { expectedVersion: started.version });
    const { open } = await overview();
    const response = await send("POST", `/v1/dpia/${open?.id}/sign`, "quality", {
      typedName: "Quinn Quality",
      sha256Seen: open?.versionSha256,
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { detail: string }).detail).toContain("prepare");
  });

  it("never crosses organisations, and refuses anyone without a DPIA permission", async () => {
    expect((await h.request("/v1/dpia", as("carer"))).status).toBe(403);
    expect((await h.request("/v1/dpia", as("owner", OTHER.tenantId))).status).toBe(403);
    const client = await h.db.pool("harbour_app").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.scope', 'tenant', true)`,
        [OTHER.tenantId, OTHER.managerId],
      );
      expect((await client.query("SELECT id FROM dpia")).rowCount).toBe(0);
      // Nothing written from here reaches the demo organisation's DPIA.
      const updated = await client.query("UPDATE dpia SET ico_reference = 'x'");
      expect(updated.rowCount).toBe(0);
      await client.query("SAVEPOINT cross_tenant");
      await expect(
        client.query(
          `INSERT INTO dpia (tenant_id, dpia_version, status, prepared_by, prefill)
           VALUES ($1, 99, 'draft', ARRAY[$2::uuid], '{}'::jsonb)`,
          [DEMO.tenantId, OTHER.managerId],
        ),
      ).rejects.toThrow(/row-level security|violates/);
      await client.query("ROLLBACK TO SAVEPOINT cross_tenant");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
