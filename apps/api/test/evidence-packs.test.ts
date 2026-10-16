import { createHash } from "node:crypto";
import { createDatabase as appDatabase, createDatabase, withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepEvidenceBundlesJob } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { observationReading, sweepEvidenceBundles } from "../src/services/evidence-pack";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Inspector evidence packs through the API (quality.md rules 1 to 10 and section 5; QUAL-003;
 * ADR-0050; hazard HZ-050): composing in the composer's scope, minimising each record field by
 * field, hand redactions checked for leaks, release and re-issue only by someone who did not
 * shape the pack, the token shown once and stored as a hash, revocation, and the bundle deleted
 * when the link ends.
 */

let h: Harness;
let inScope: string;
let outOfScope: string;

const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

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

const today = () => new Date().toISOString().slice(0, 10);

/** Runs `fn` with `who`'s sign-in an hour old, past the step-up window, then puts it back. */
async function withStaleSignIn<T>(who: string, fn: () => Promise<T>): Promise<T> {
  const auth = h.db.pool("harbour_auth");
  const token = (h.tokens[who] ?? "").split(".")[0];
  const update = "UPDATE auth.session SET created_at = $2 WHERE token = $1";
  await auth.query(update, [token, new Date(Date.now() - 3_600_000)]);
  try {
    return await fn();
  } finally {
    await auth.query(update, [token, new Date()]);
  }
}

interface Field {
  key: string;
  kind: string;
  outcome: string;
  reason: string | null;
  value: string | null;
  redactedBy: string | null;
}
interface Pack {
  id: string;
  state: string;
  version: number;
  watermark: string;
  contributorIds: string[];
  bundleDeleted: boolean;
  items: { id: string; recordId: string; exclusionReason: string | null; fields: Field[] }[];
  links: {
    id: string;
    revokedAt: string | null;
    revocationReason: string | null;
    version?: number;
  }[];
}

async function note(personId: string, body: string, occurredAt = new Date()) {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, created_by)
     VALUES ($1, $2, $3, 'personal_care', $4, $5) RETURNING id`,
    [personId, DEMO.locationId, occurredAt, body, DEMO.users.carer.id],
  );
  return row?.id as string;
}

async function compose(who = "manager"): Promise<Pack> {
  const response = await as(who, "/v1/evidence-packs", {
    method: "POST",
    body: {
      recipient: { name: "Ivy Inspector", organisation: "CQC", email: " Ivy@Example.invalid " },
      purpose: "Assessment of Harbour House, safe key question",
      from: "2026-01-01",
      to: today(),
      locationIds: [DEMO.locationId],
      qualityStatementIds: null,
      personIds: [inScope],
    },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Pack;
}

async function addNote(pack: Pack, noteId: string, who = "manager") {
  return as(who, `/v1/evidence-packs/${pack.id}/items`, {
    method: "POST",
    body: {
      items: [{ recordType: "care_note", recordId: noteId, qualityStatementIds: ["safe.1"] }],
      version: pack.version,
    },
  });
}

beforeAll(async () => {
  h = await createHarness();
  const people = await sql<{ id: string }>(
    "SELECT id FROM person WHERE location_id = $1 AND status = 'active' ORDER BY id LIMIT 2",
    [DEMO.locationId],
  );
  inScope = people[0]?.id as string;
  outOfScope = people[1]?.id as string;
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-050 composing and minimising an evidence pack", () => {
  let pack: Pack;
  let itemId: string;

  it("composes a draft in the composer's name with the watermark; a care worker cannot", async () => {
    pack = await compose();
    expect(pack.state).toBe("draft");
    expect(pack.watermark).toContain("Prepared for Ivy Inspector, CQC.");
    const [row] = await sql<{ recipient_email: string; composed_by: string }>(
      "SELECT recipient_email, composed_by FROM evidence_pack WHERE id = $1",
      [pack.id],
    );
    expect(row).toEqual({
      recipient_email: "ivy@example.invalid",
      composed_by: DEMO.users.manager.id,
    });
    const refused = await as("carer", "/v1/evidence-packs", {
      method: "POST",
      body: {
        recipient: { name: "Ivy", organisation: "CQC", email: "ivy@example.invalid" },
        purpose: "Assessment of Harbour House",
        from: "2026-01-01",
        to: today(),
        locationIds: [DEMO.locationId],
        qualityStatementIds: null,
        personIds: [inScope],
      },
    });
    expect(refused.status).toBe(403);
  });

  it("refuses a person or location the composer cannot see", async () => {
    const response = await as("manager", "/v1/evidence-packs", {
      method: "POST",
      body: {
        recipient: { name: "Ivy", organisation: "CQC", email: "ivy@example.invalid" },
        purpose: "Assessment of Harbour House",
        from: "2026-01-01",
        to: today(),
        locationIds: [DEMO.locationId],
        qualityStatementIds: null,
        personIds: [LODGE.personId],
      },
    });
    expect(response.status).toBe(422);
  });

  it("adds a record minimised field by field: free text withheld, staff as a role, nothing withheld stored", async () => {
    const response = await addNote(pack, await note(inScope, "Ate well with Gwen Visitor today."));
    expect(response.status).toBe(200);
    pack = (await response.json()) as Pack;
    const [item] = pack.items;
    itemId = item?.id as string;
    const byKey = new Map(item?.fields.map((f) => [f.key, f]));
    expect(byKey.get("text")).toMatchObject({
      outcome: "withheld",
      reason: "free_text_not_reviewed",
      value: null,
    });
    expect(byKey.get("author")).toMatchObject({ outcome: "redacted", value: "[member of staff]" });
    expect(byKey.get("nhs_number")).toMatchObject({ outcome: "withheld", value: null });
    expect(byKey.get("category")).toMatchObject({ outcome: "included", value: "personal care" });
    const [bundle] = await sql<{ content: string }>(
      "SELECT content::text FROM evidence_pack_bundle WHERE pack_id = $1",
      [pack.id],
    );
    expect(bundle?.content).not.toContain("Gwen Visitor");
    expect(bundle?.content).not.toContain("Cat Carer");
    const [stored] = await sql<{ fields: string }>(
      "SELECT fields::text FROM evidence_pack_item WHERE id = $1",
      [itemId],
    );
    expect(stored?.fields).not.toContain("Ate well");
  });

  it("keeps a record about someone outside the pack's scope out, with the reason", async () => {
    const response = await addNote(pack, await note(outOfScope, "Slept well."));
    pack = (await response.json()) as Pack;
    expect(pack.items.find((i) => i.exclusionReason !== null)?.exclusionReason).toBe(
      "person_not_in_scope",
    );
  });

  it("treats typed text inside an observation's reading as free text, never as the reading", async () => {
    const [obs] = await sql<{ id: string }>(
      `INSERT INTO observation (person_id, location_id, occurred_at, chart, values, created_by)
       VALUES ($1, $2, now(), 'fluid_intake',
         '{"chart": "fluid_intake", "ml": 200, "drink": "Tea from Gwen Visitor", "iddsiLevel": "2", "refused": false}', $3)
       RETURNING id`,
      [inScope, DEMO.locationId, DEMO.users.carer.id],
    );
    const response = await as("manager", `/v1/evidence-packs/${pack.id}/items`, {
      method: "POST",
      body: {
        items: [{ recordType: "observation", recordId: obs?.id, qualityStatementIds: ["safe.2"] }],
        version: pack.version,
      },
    });
    expect(response.status).toBe(200);
    pack = (await response.json()) as Pack;
    const fields = pack.items.find((i) => i.recordId === obs?.id)?.fields ?? [];
    expect(fields.find((f) => f.key === "values")).toMatchObject({
      outcome: "included",
      value: "Amount 200 ml; IDDSI level: 2; Refused: No",
    });
    expect(fields.find((f) => f.key === "comment")).toMatchObject({
      outcome: "withheld",
      value: null,
    });
  });

  it("counts only the chart schema's own values as codes: a typed word goes to hand review", () => {
    expect(observationReading("fluid_output", { ml: 100, kind: "sarah" })).toEqual({
      reading: ["Amount 100 ml"],
      typed: ["sarah"],
    });
    expect(observationReading("vitals", { temperature: 37.2, consciousness: "alert" })).toEqual({
      reading: ["Consciousness: alert", "Temperature 37.2 °C"],
      typed: [],
    });
    expect(observationReading("weight", { kg: 70, unexpectedKey: "anything" }).typed).toEqual([
      "anything",
    ]);
  });

  it("refuses a record the composer cannot see, and a record already in the pack", async () => {
    const [lodge] = await sql<{ id: string }>(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body)
       VALUES ($1, $2, now(), 'other', 'Elsewhere.') RETURNING id`,
      [LODGE.personId, LODGE.locationId],
    );
    expect((await addNote(pack, lodge?.id as string)).status).toBe(404);
    const again = await addNote(pack, pack.items[0]?.recordId as string);
    expect(again.status).toBe(409);
  });

  it("refuses a hand redaction that still names someone, and takes a clean one in the redactor's name", async () => {
    const url = `/v1/evidence-packs/${pack.id}/items/${itemId}/fields/text/redaction`;
    const leaky = await as("manager", url, {
      method: "PUT",
      body: { text: "Ate well with Cat Carer today.", version: pack.version },
    });
    expect(leaky.status).toBe(422);
    const clean = await as("manager", url, {
      method: "PUT",
      body: { text: "Ate well with [visitor] today.", version: pack.version },
    });
    expect(clean.status).toBe(200);
    pack = (await clean.json()) as Pack;
    const text = pack.items
      .flatMap((i) => i.fields)
      .find((f) => f.key === "text" && f.outcome === "redacted");
    expect(text).toMatchObject({
      value: "Ate well with [visitor] today.",
      redactedBy: DEMO.users.manager.id,
    });
    expect(pack.items.some((i) => i.id === itemId)).toBe(false);
  });

  it("refuses release by the composer, then releases by someone else with the link shown once and stored as a hash", async () => {
    const own = await as("manager", `/v1/evidence-packs/${pack.id}/release`, {
      method: "POST",
      body: { version: pack.version },
    });
    expect(own.status).toBe(403);
    const stale = await withStaleSignIn("owner", () =>
      as("owner", `/v1/evidence-packs/${pack.id}/release`, {
        method: "POST",
        body: { version: pack.version },
      }),
    );
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe("step_up_required");
    const response = await as("owner", `/v1/evidence-packs/${pack.id}/release`, {
      method: "POST",
      body: { version: pack.version },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const issued = (await response.json()) as { linkId: string; token: string; expiresAt: string };
    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    const [link] = await sql<{ token_hash: string }>(
      "SELECT token_hash FROM evidence_pack_link WHERE id = $1",
      [issued.linkId],
    );
    expect(link?.token_hash).toBe(createHash("sha256").update(issued.token).digest("hex"));
    const audits = await sql<{ action: string; scope: string }>(
      "SELECT action, scope::text FROM audit_event WHERE resource_id = $1",
      [pack.id],
    );
    expect(audits.map((a) => a.action)).toContain("quality.evidence_pack.released");
    expect(audits.some((a) => a.scope?.includes(issued.token))).toBe(false);
    const events = await sql<{ event_type: string }>(
      "SELECT event_type FROM outbox_event WHERE aggregate_id = $1",
      [pack.id],
    );
    expect(events.map((e) => e.event_type)).toContain("quality.evidence_pack.released");
  });

  it("issues a new link only as a release: the old one revoked as re-issued", async () => {
    const detail = (await (await as("owner", `/v1/evidence-packs/${pack.id}`)).json()) as Pack;
    const [old] = await sql<{ id: string; version: number }>(
      "SELECT id, version FROM evidence_pack_link WHERE pack_id = $1",
      [pack.id],
    );
    expect(detail.links).toHaveLength(1);
    const byComposer = await as(
      "manager",
      `/v1/evidence-packs/${pack.id}/links/${old?.id}/reissue`,
      {
        method: "POST",
        body: { version: old?.version },
      },
    );
    expect(byComposer.status).toBe(403);
    const stale = await withStaleSignIn("owner", () =>
      as("owner", `/v1/evidence-packs/${pack.id}/links/${old?.id}/reissue`, {
        method: "POST",
        body: { version: old?.version },
      }),
    );
    expect(((await stale.json()) as { code: string }).code).toBe("step_up_required");
    const response = await as("owner", `/v1/evidence-packs/${pack.id}/links/${old?.id}/reissue`, {
      method: "POST",
      body: { version: old?.version },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const links = await sql<{
      id: string;
      revocation_reason: string | null;
      replaces_link_id: string | null;
    }>(
      "SELECT id, revocation_reason, replaces_link_id FROM evidence_pack_link WHERE pack_id = $1 ORDER BY issued_at",
      [pack.id],
    );
    expect(links[0]?.revocation_reason).toBe("reissued");
    expect(links[1]).toMatchObject({ revocation_reason: null, replaces_link_id: old?.id });
  });

  it("revokes a released pack: the link stops, the bundle is deleted and the manifest stays", async () => {
    const current = (await (await as("manager", `/v1/evidence-packs/${pack.id}`)).json()) as Pack;
    const response = await as("manager", `/v1/evidence-packs/${pack.id}/revoke`, {
      method: "POST",
      body: { reason: "Sent to the wrong inspector", version: current.version },
    });
    expect(response.status).toBe(200);
    const revoked = (await response.json()) as Pack;
    expect(revoked).toMatchObject({ state: "revoked", bundleDeleted: true });
    expect(revoked.links.every((l) => l.revokedAt !== null)).toBe(true);
    expect(revoked.items.flatMap((i) => i.fields).every((f) => f.value === null)).toBe(true);
    expect(revoked.items.length).toBeGreaterThan(0);
  });
});

describe("hazard HZ-050 the bundle goes when the link ends", () => {
  it("discarding a draft deletes its bundle", async () => {
    const pack = await compose();
    const added = (await (
      await addNote(pack, await note(inScope, "Walked in the garden."))
    ).json()) as Pack;
    const response = await as("manager", `/v1/evidence-packs/${pack.id}/discard`, {
      method: "POST",
      body: { reason: "Not needed after all", version: added.version },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Pack).bundleDeleted).toBe(true);
  });

  it("the sweep deletes the bundle of a pack whose link has expired, once, audited", async () => {
    const pack = await compose();
    const added = (await (
      await addNote(pack, await note(inScope, "Read the paper."))
    ).json()) as Pack;
    const expiresAt = new Date(Date.now() + 1500).toISOString();
    const released = await as("owner", `/v1/evidence-packs/${pack.id}/release`, {
      method: "POST",
      body: { version: added.version, expiresAt },
    });
    expect(released.status).toBe(201);
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    // Still open: nothing to delete, and the bundle is still there.
    expect(await sweepEvidenceBundlesJob(deps)).toBe(0);
    const [live] = await sql<{ content: unknown }>(
      "SELECT content FROM evidence_pack_bundle WHERE pack_id = $1",
      [pack.id],
    );
    expect(live?.content).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // Another organisation's sweep never reaches this one's bundles.
    const other = await withRequestContext(
      appDatabase(h.db.pool("harbour_app")),
      { tenantId: OTHER.tenantId, userId: null, scope: "tenant", locationIds: [] },
      (tx) => sweepEvidenceBundles(tx, OTHER.tenantId, new Date()),
    );
    expect(other).toBe(0);
    expect(await sweepEvidenceBundlesJob(deps)).toBe(1);
    expect(await sweepEvidenceBundlesJob(deps)).toBe(0);
    const [bundle] = await sql<{ content: unknown; deletion_reason: string }>(
      "SELECT content, deletion_reason FROM evidence_pack_bundle WHERE pack_id = $1",
      [pack.id],
    );
    expect(bundle).toEqual({ content: null, deletion_reason: "link_ended" });
    const audits = await sql<{ action: string; reason: string }>(
      "SELECT action, reason FROM audit_event WHERE resource_id = $1 AND action = 'quality.evidence_pack.bundle_deleted'",
      [pack.id],
    );
    expect(audits).toEqual([
      { action: "quality.evidence_pack.bundle_deleted", reason: "link_ended" },
    ]);
    // An ended link cannot be issued again: the pack's content has gone.
    const [link] = await sql<{ id: string; version: number }>(
      "SELECT id, version FROM evidence_pack_link WHERE pack_id = $1",
      [pack.id],
    );
    const reissue = await as("owner", `/v1/evidence-packs/${pack.id}/links/${link?.id}/reissue`, {
      method: "POST",
      body: { version: link?.version },
    });
    expect(reissue.status).toBe(409);
  });
});

describe("hazard HZ-050 a pack says how each entry came to be, and shows the record as it stands", () => {
  const fieldsOf = (pack: Pack, recordId: string) =>
    new Map(pack.items.find((i) => i.recordId === recordId)?.fields.map((f) => [f.key, f]));

  it("labels a correction of an earlier entry, its reason withheld until redacted", async () => {
    const pack = await compose();
    const first = await note(inScope, "Had a bath.");
    const [fix] = await sql<{ id: string }>(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, created_by,
         supersedes_id, correction_reason)
       VALUES ($1, $2, now(), 'personal_care', 'Had a shower.', $3, $4, 'Wrong word used')
       RETURNING id`,
      [inScope, DEMO.locationId, DEMO.users.carer.id, first],
    );
    expect((await addNote(pack, first)).status).toBe(409);
    const added = (await (await addNote(pack, fix?.id as string)).json()) as Pack;
    const fields = fieldsOf(added, fix?.id as string);
    expect(fields.get("correction_of")?.outcome).toBe("included");
    expect(fields.get("correction_of")?.value).toMatch(
      /^Correction of an earlier entry recorded \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} (GMT|BST)$/,
    );
    expect(fields.get("correction_reason")).toMatchObject({ outcome: "withheld", value: null });
    expect(fields.get("recorded_at")?.value).toMatch(/ (GMT|BST)$/);
  });

  it("labels a back-entry from paper with the paper time and the outage, and a wrong device clock", async () => {
    const declared = await as("manager", `/v1/locations/${DEMO.locationId}/outages`, {
      method: "POST",
      body: {
        kind: "power",
        description: "Power cut, whole building",
        startedAt: new Date(Math.floor((Date.now() - 30 * 60_000) / 60_000) * 60_000).toISOString(),
      },
    });
    expect(declared.status).toBe(201);
    const { id: outageId } = (await declared.json()) as { id: string };
    const at = new Date(Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000);
    const [paper] = await sql<{ id: string }>(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, created_by,
         late_entry_reason, outage_id, paper_date, paper_time, paper_occurrence, paper_reference,
         clock_drift)
       VALUES ($1, $2, $3::timestamptz, 'personal_care', 'Assisted with a wash.', $4, 'downtime', $5,
         ($3::timestamptz AT TIME ZONE 'Europe/London')::date,
         ($3::timestamptz AT TIME ZONE 'Europe/London')::time, 'only', 'DT-001', true)
       RETURNING id`,
      [inScope, DEMO.locationId, at, DEMO.users.carer.id, outageId],
    );
    const pack = await compose();
    const added = (await (await addNote(pack, paper?.id as string)).json()) as Pack;
    const fields = fieldsOf(added, paper?.id as string);
    expect(fields.get("back_entry")?.outcome).toBe("included");
    expect(fields.get("back_entry")?.value).toMatch(
      /^Written on paper at \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} during a power outage from .+ (GMT|BST), and entered in Harbour later$/,
    );
    expect(fields.get("paper_reference")).toMatchObject({ outcome: "withheld", value: null });
    expect(fields.get("clock_drift")).toMatchObject({
      outcome: "included",
      value: "The device's clock was wrong when this was written",
    });
  });

  it("refuses release when a record was corrected after it was added, saying which", async () => {
    const pack = await compose();
    const noted = await note(inScope, "Went for a walk.");
    const added = (await (await addNote(pack, noted)).json()) as Pack;
    await sql(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, created_by,
         supersedes_id, correction_reason)
       VALUES ($1, $2, now(), 'activity', 'Went to the garden.', $3, $4, 'Wrong place')`,
      [inScope, DEMO.locationId, DEMO.users.carer.id, noted],
    );
    const response = await as("owner", `/v1/evidence-packs/${pack.id}/release`, {
      method: "POST",
      body: { version: added.version },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { detail: string }).detail).toContain(
      "Care note: personal care",
    );
    const [row] = await sql<{ state: string }>("SELECT state FROM evidence_pack WHERE id = $1", [
      pack.id,
    ]);
    expect(row?.state).toBe("draft");
  });
});
