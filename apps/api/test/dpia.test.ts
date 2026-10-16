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
};

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
    expect((await send("PUT", "/v1/settings/data-protection", "manager", settings)).status).toBe(
      403,
    );
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
    const saved = await send("PUT", "/v1/settings/data-protection", "owner", settings);
    expect(saved.status).toBe(200);
    expect((await overview()).missingConfig).toEqual([]);
    const refused = await send("PUT", "/v1/settings/data-protection", "owner", {
      ...settings,
      leadId: OTHER.managerId,
    });
    expect(refused.status).toBe(422);
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
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
