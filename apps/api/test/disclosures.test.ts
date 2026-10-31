import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness, OTHER } from "./support/harness";

/**
 * Disclosure requests through the API (SAFE-016; safety.md section 11, rules 38 to 44; migration
 * 0103; hazard HZ-011): a legal basis on every request; the DSAR collector; a person decides each
 * record; the approver is never the requester; release needs a fresh step-up and stores the pack
 * as issued; a coroner's Regulation 28 report and its response date from the rate table.
 * Invented people only.
 */

let h: Harness;
let ada: string;

const as = (who: string) => ({ token: h.tokens[who], tenant: DEMO.tenantId });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const get = (path: string, who = "manager") => send("GET", path, who);
const post = (path: string, body: unknown, who = "manager") => send("POST", path, who, body);
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

type Request = {
  id: string;
  version: number;
  state: string;
  legalBasis: string;
  dueAt: string | null;
  packSha256: string | null;
  items: { total: number; pending: number };
  prevention: { reportOn: string; responseDueOn: string; state: string } | null;
};
type Item = { id: string; version: number; tableName: string };

async function owner<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows as T[];
  } finally {
    client.release();
  }
}

const today = () => new Date().toISOString().slice(0, 10);

async function logRequest(body: Record<string, unknown> = {}, who = "manager"): Promise<Request> {
  const r = await post(
    "/v1/disclosures",
    {
      personId: ada,
      type: "coroner",
      requester: { name: "Coroner's officer", organisation: "HM Coroner (example)" },
      receivedAt: new Date(Date.now() - 3_600_000).toISOString(),
      ...body,
    },
    who,
  );
  expect(r.status).toBe(201);
  return (await r.json()) as Request;
}

async function decideAll(id: string, decision = "disclose") {
  const items = ((await (await get(`/v1/disclosures/${id}/items`)).json()) as { items: Item[] })
    .items;
  for (const item of items) {
    const detail = (await (await get(`/v1/disclosures/${id}/items/${item.id}`)).json()) as {
      contentSha256: string;
    };
    const r = await post(`/v1/disclosures/${id}/items/${item.id}/decision`, {
      expectedVersion: item.version,
      contentSha256: detail.contentSha256,
      decision,
      ...(decision === "withhold" ? { reason: "Third-party information." } : {}),
    });
    expect(r.status).toBe(200);
  }
  return items;
}

async function current(id: string) {
  return (await (await get(`/v1/disclosures/${id}`)).json()) as Request;
}

async function toApproved(): Promise<Request> {
  const req = await logRequest();
  expect((await post(`/v1/disclosures/${req.id}/collect`, {})).status).toBe(200);
  await decideAll(req.id);
  const prepared = await post(`/v1/disclosures/${req.id}/prepare`, {
    expectedVersion: (await current(req.id)).version,
  });
  expect(prepared.status).toBe(200);
  const p = (await prepared.json()) as Request;
  const approved = await post(
    `/v1/disclosures/${req.id}/decision`,
    { expectedVersion: p.version, decision: "approve" },
    "owner",
  );
  expect(approved.status).toBe(200);
  return (await approved.json()) as Request;
}

beforeAll(async () => {
  h = await createHarness();
  const [p] = await owner<{ id: string }>(
    "SELECT id FROM person WHERE given_name = 'Ada' AND family_name = 'Example'",
  );
  ada = p?.id as string;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("SAFE-016 who may act on a disclosure request", () => {
  it("refuses a care worker, and hides requests from them", async () => {
    await logRequest();
    expect((await get("/v1/disclosures", "carer")).status).toBe(403);
    const r = await post(
      "/v1/disclosures",
      {
        personId: ada,
        type: "coroner",
        requester: { name: "Officer", organisation: "HM Coroner (example)" },
        receivedAt: new Date().toISOString(),
      },
      "carer",
    );
    expect(r.status).toBe(403);
  });

  it("does not find a person in another organisation", async () => {
    const r = await post("/v1/disclosures", {
      personId: OTHER.personId,
      type: "coroner",
      requester: { name: "Officer", organisation: "HM Coroner (example)" },
      receivedAt: new Date().toISOString(),
    });
    expect(r.status).toBe(404);
  });
});

describe("SAFE-016 rule 38: every request carries its legal basis", () => {
  it("stores the legal basis for the type", async () => {
    const req = await logRequest();
    expect(req.legalBasis.length).toBeGreaterThan(10);
    expect(req.state).toBe("requested");
  });

  it("an Access to Health Records Act request needs the person to have died", async () => {
    const r = await post("/v1/disclosures", {
      personId: ada,
      type: "access_to_health_records",
      requester: { name: "Personal representative", organisation: "Example executors" },
      receivedAt: new Date().toISOString(),
    });
    expect(r.status).toBe(422);
    expect(await codeOf(r)).toBe("person_not_deceased");
  });

  it("police requests need a stated purpose before they are prepared", async () => {
    const req = await logRequest({
      type: "police",
      requester: { name: "DC Example", organisation: "Example Police" },
    });
    await post(`/v1/disclosures/${req.id}/collect`, {});
    await decideAll(req.id);
    const r = await post(`/v1/disclosures/${req.id}/prepare`, {
      expectedVersion: (await current(req.id)).version,
    });
    expect(r.status).toBe(422);
    expect(await codeOf(r)).toBe("disclosure_not_ready");
  });
});

describe("SAFE-016 rules 39 to 41: collect, review, approve", () => {
  it("collects the person's records once, and needs every record decided before preparing", async () => {
    const req = await logRequest();
    const first = (await (await post(`/v1/disclosures/${req.id}/collect`, {})).json()) as {
      added: number;
      total: number;
      notSearched: unknown[];
    };
    expect(first.added).toBeGreaterThan(0);
    const again = (await (await post(`/v1/disclosures/${req.id}/collect`, {})).json()) as {
      added: number;
      total: number;
    };
    expect(again.added).toBe(0);
    expect(again.total).toBe(first.total);
    const r = await post(`/v1/disclosures/${req.id}/prepare`, {
      expectedVersion: (await current(req.id)).version,
    });
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("disclosure_items_pending");
  });

  it("a decision is bound to the record as it was opened", async () => {
    const req = await logRequest();
    await post(`/v1/disclosures/${req.id}/collect`, {});
    const [item] = (
      (await (await get(`/v1/disclosures/${req.id}/items`)).json()) as {
        items: Item[];
      }
    ).items;
    const r = await post(`/v1/disclosures/${req.id}/items/${item?.id}/decision`, {
      expectedVersion: item?.version,
      contentSha256: "0".repeat(64),
      decision: "disclose",
    });
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("disclosure_record_changed");
  });

  it("the person who logged it cannot approve it", async () => {
    const req = await logRequest({}, "owner");
    await post(`/v1/disclosures/${req.id}/collect`, {}, "owner");
    await decideAll(req.id);
    const p = await post(`/v1/disclosures/${req.id}/prepare`, {
      expectedVersion: (await current(req.id)).version,
    });
    expect(p.status).toBe(200);
    const r = await post(
      `/v1/disclosures/${req.id}/decision`,
      { expectedVersion: ((await p.json()) as Request).version, decision: "approve" },
      "owner",
    );
    expect(r.status).toBe(403);
    expect(await codeOf(r)).toBe("disclosure_approver_is_requester");
  });

  it("a member without safety.disclosure.approve is refused", async () => {
    const req = await logRequest();
    const r = await post(
      `/v1/disclosures/${req.id}/decision`,
      { expectedVersion: req.version, decision: "refuse", reason: "Not a lawful request." },
      "carer",
    );
    expect(r.status).toBe(403);
  });
});

describe("SAFE-016 rules 42 and 43: release with step-up, the pack as issued", () => {
  it("needs a fresh step-up to release and to fetch the pack", async () => {
    const req = await toApproved();
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.manager?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const r = await post(`/v1/disclosures/${req.id}/release`, { expectedVersion: req.version });
      expect(r.status).toBe(403);
    } finally {
      await ageSession(auth, session, 0);
    }
  });

  it("releases, stores the pack and freezes the request", async () => {
    const req = await toApproved();
    const r = await post(`/v1/disclosures/${req.id}/release`, { expectedVersion: req.version });
    expect(r.status).toBe(200);
    const released = (await r.json()) as Request;
    expect(released.state).toBe("released");
    expect(released.packSha256).toMatch(/^[0-9a-f]{64}$/);
    const pack = (await (await get(`/v1/disclosures/${req.id}/pack`)).json()) as {
      sha256: string;
      records: unknown[];
      legalBasis: string;
    };
    expect(pack.sha256).toBe(released.packSha256);
    expect(pack.records.length).toBe(released.items.total);
    expect(pack.legalBasis).toBe(req.legalBasis);
    const w = await post(`/v1/disclosures/${req.id}/withdraw`, {
      expectedVersion: released.version,
      reason: "Changed our mind.",
    });
    expect(w.status).toBe(409);
    const audit = await owner<{ scope: Record<string, unknown> }>(
      "SELECT scope FROM audit_event WHERE action = 'safety.disclosure.released' AND resource_id = $1",
      [req.id],
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.scope)).not.toMatch(/Coroner|Example/);
  });
});

describe("SAFE-016 rule 44: a coroner's Regulation 28 report", () => {
  it("dates the response from the rate table, for coroner requests only", async () => {
    const req = await logRequest();
    const r = await post(`/v1/disclosures/${req.id}/prevention-report`, {
      expectedVersion: req.version,
      reportOn: today(),
    });
    expect(r.status).toBe(200);
    const out = (await r.json()) as Request;
    expect(out.prevention?.state).toBe("due");
    const days =
      (Date.parse(out.prevention?.responseDueOn ?? "") - Date.parse(today())) / 86_400_000;
    expect(days).toBe(56);
    const police = await logRequest({
      type: "police",
      requester: { name: "DC Example", organisation: "Example Police" },
      statedPurpose: "Investigation of an offence.",
    });
    const p = await post(`/v1/disclosures/${police.id}/prevention-report`, {
      expectedVersion: police.version,
      reportOn: today(),
    });
    expect(p.status).toBe(422);
    expect(await codeOf(p)).toBe("not_a_coroner_request");
  });
});
