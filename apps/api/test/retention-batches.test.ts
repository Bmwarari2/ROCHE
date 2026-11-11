import type {
  DestructionBatch,
  DestructionBatchItemList,
  DestructionBatchList,
  ProblemDetails,
} from "@harbour/contracts";
import { withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { emptyCounts, proposalPlan, RETENTION_REGISTRY } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepRetentionReports } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { proposeBatches } from "../src/services/retention-batches";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The retention sweep in propose mode (retention sweeps plan 5.4, 5.5 and 5.8, slice 6;
 * ADR-0135): off unless both flags are on; once on, destruction batches per class of records due,
 * never a held record, a record about a person with an open complaint, DSAR case or safeguarding
 * concern, a record about a member of staff or one the report does not decide; and no record in
 * any table is changed, hidden or removed. Batches are listed and cancelled through the API by
 * tenant-wide holders of platform.retention.manage with step-up, each audited. The clock is
 * injected.
 */

const json = async <T>(response: Response) => (await response.json()) as T;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TABLES = RETENTION_REGISTRY.map((e) => e.table).filter((t) => !t.includes("."));
/** Every registry table but the audit trail and the batches, which the sweep adds to. */
const RECORD_TABLES = TABLES.filter(
  (t) => !["audit_event", "destruction_batch", "destruction_batch_item"].includes(t),
);
const NEVER_PROPOSED = new Set(
  RETENTION_REGISTRY.filter((e) => proposalPlan(e).kind === "skip").map((e) => e.table),
);
const FAR = new Date("2200-01-01T00:00:00Z");

describe("destruction batches", () => {
  let h: Harness;
  let held: string;
  let complained: string;
  let dsarPerson: string;
  let dsarContact: string;
  let safeguarded: string;
  let free: string;

  const as = (
    user: keyof Harness["tokens"],
    path: string,
    init: { method?: string; body?: unknown } = {},
    tenant: string = DEMO.tenantId,
  ) => h.request(path, { token: h.tokens[user], tenant, ...init });

  /** One statement as the owner in an organisation's context, in a transaction of its own. */
  async function asOwner<T extends pg.QueryResultRow>(
    tenantId: string,
    text: string,
    params: unknown[] = [],
    userId = "",
  ): Promise<T[]> {
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true),
                set_config('app.user_id', $2, true)`,
        [tenantId, userId],
      );
      const { rows } = await client.query<T>(text, params);
      await client.query("COMMIT");
      return rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** A fingerprint of every registry record table in both organisations: count and content hash. */
  async function fingerprint(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const tenantId of [DEMO.tenantId, OTHER.tenantId]) {
      for (const table of RECORD_TABLES) {
        const [row] = await asOwner<{ n: number; hash: string | null }>(
          tenantId,
          `SELECT count(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash
           FROM public.${table} t`,
        );
        result[`${tenantId}:${table}`] = `${row?.n}:${row?.hash ?? ""}`;
      }
    }
    return result;
  }

  const sweep = (now: Date) =>
    sweepRetentionReports(
      {
        workerPool: h.db.pool("harbour_worker"),
        appDb: h.handle.services.db,
        logger: createLogger("silent"),
      },
      now,
    );

  const flag = (key: string) =>
    asOwner(
      DEMO.tenantId,
      "INSERT INTO feature_flag (flag_key, location_id, enabled) VALUES ($1, NULL, true)",
      [key],
    );

  const items = () =>
    asOwner<{ table_name: string; subject_ids: string[]; record_class: string }>(
      DEMO.tenantId,
      "SELECT table_name, subject_ids::text[] AS subject_ids, record_class FROM destruction_batch_item",
    );

  const audited = (action: string) =>
    asOwner<{ resource_id: string | null; scope: Record<string, unknown> }>(
      DEMO.tenantId,
      "SELECT resource_id, scope FROM audit_event WHERE action = $1 ORDER BY seq",
      [action],
    );

  beforeAll(async () => {
    h = await createHarness();
    // Every resident has an allergy record and leaves care, so their records fall due far
    // ahead. One is held; one has an open complaint; one an open DSAR case about them; one an open
    // DSAR case about their contact; one an open safeguarding concern; the last has none.
    const people = await asOwner<{ id: string; location_id: string }>(
      DEMO.tenantId,
      "SELECT id, location_id FROM person WHERE id <> $1 ORDER BY id LIMIT 6",
      [LODGE.personId],
    );
    expect(people).toHaveLength(6);
    [held, complained, dsarPerson, dsarContact, safeguarded, free] = people.map((p) => p.id) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const location = (personId: string) => people.find((p) => p.id === personId)?.location_id;
    const all = people.map((p) => p.id);
    await asOwner(
      DEMO.tenantId,
      `INSERT INTO allergy (person_id, substance, severity)
       SELECT p, 'Latex', 'mild' FROM unnest($1::uuid[]) p
       WHERE NOT EXISTS (SELECT 1 FROM allergy a WHERE a.person_id = p)`,
      [all],
    );
    await asOwner(
      DEMO.tenantId,
      "UPDATE person SET status = 'discharged', discharged_at = '2026-10-01T10:00:00Z' WHERE id = ANY($1)",
      [all],
    );
    await asOwner(
      DEMO.tenantId,
      "INSERT INTO legal_hold (person_id, reason) VALUES ($1, 'Claim notified by the insurer')",
      [held],
    );
    await asOwner(
      DEMO.tenantId,
      `INSERT INTO complaint (location_id, person_id, complainant_name, complainant_relationship,
         channel, received_at, knew_of_matter_on, summary, recorded_by)
       VALUES ($1, $2, 'Eve Example', 'family_or_friend', 'email', now(), current_date,
         'About the laundry service', $3)`,
      [location(complained), complained, DEMO.users.owner.id],
    );
    const owner = DEMO.users.owner.id;
    await asOwner(
      DEMO.tenantId,
      `INSERT INTO dsar_case (request_kind, subject_kind, subject_person_id, requester_kind, channel, received_on)
       VALUES ('access', 'person', $1, 'subject', 'email', current_date)`,
      [dsarPerson],
      owner,
    );
    await asOwner(
      DEMO.tenantId,
      `INSERT INTO dsar_case (request_kind, subject_kind, subject_person_id, subject_contact_id,
         requester_kind, channel, received_on)
       SELECT 'access', 'contact', c.person_id, c.id, 'subject', 'email', current_date
       FROM contact c WHERE c.person_id = $1 LIMIT 1`,
      [dsarContact],
      owner,
    );
    await asOwner(
      DEMO.tenantId,
      `INSERT INTO safeguarding_concern (location_id, person_id, abuse_types, description, raised_at,
         referral_due_at)
       VALUES ($1, $2, '{neglect}', 'Fixture concern', now(), now() + interval '24 hours')`,
      [location(safeguarded), safeguarded],
      owner,
    );
    const cases = await asOwner<{ n: number }>(
      DEMO.tenantId,
      "SELECT count(*)::int AS n FROM dsar_case WHERE status = 'open'",
      [],
      owner,
    );
    expect(cases[0]?.n).toBe(2);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it("respects a hold placed between the scan and the insert", async () => {
    const lines = [
      {
        table: "allergy",
        recordClass: "care_record",
        reason: null,
        counts: { ...emptyCounts(), due: 1 },
      },
    ];
    const context = {
      tenantId: DEMO.tenantId,
      userId: null,
      scope: "tenant" as const,
      locationIds: [],
    };
    let scanned = 0;
    const result = await withRequestContext(h.handle.services.db, context, (tx) =>
      proposeBatches(tx, DEMO.tenantId, FAR, lines, {
        afterScan: async (candidates) => {
          scanned = candidates;
          // Committed on its own connection while the sweep has not yet taken the lock.
          await asOwner(
            DEMO.tenantId,
            "INSERT INTO legal_hold (person_id, reason) VALUES ($1, 'Inquest opened')",
            [free],
          );
        },
      }),
    );
    // The scan found the free resident's allergy record, and the re-check under the lock dropped it.
    expect(scanned).toBe(1);
    expect(result.batches).toEqual([]);
    expect(await items()).toEqual([]);
    await asOwner(
      DEMO.tenantId,
      `UPDATE legal_hold SET released_at = now(), released_by = $2, release_reason = 'Inquest closed'
       WHERE person_id = $1 AND released_at IS NULL`,
      [free, DEMO.users.owner.id],
      DEMO.users.owner.id,
    );
  });

  it("is off unless both flags are on: propose alone proposes nothing", async () => {
    await flag("platform.retention.sweep_propose");
    expect(await sweep(FAR)).toBe(0);
    expect(await items()).toEqual([]);
    const response = await as("owner", "/v1/retention/batches");
    expect(response.status).toBe(200);
    expect(await json<DestructionBatchList>(response)).toEqual({ items: [], nextCursor: null });
  });

  it("in propose mode proposes records due, never held or open-case ones, and changes no record", async () => {
    await flag("platform.retention.sweep_report");
    const before = await fingerprint();
    expect(await sweep(FAR)).toBe(1);
    expect(await fingerprint()).toEqual(before);

    const proposed = await items();
    expect(proposed.length).toBeGreaterThan(0);
    const subjects = new Set(proposed.flatMap((i) => i.subject_ids));
    // The free resident's records are proposed; never those of someone held, or with an open
    // complaint, DSAR case (about them or their contact) or safeguarding concern.
    expect(subjects.has(free)).toBe(true);
    for (const excluded of [held, complained, dsarPerson, dsarContact, safeguarded]) {
      expect(subjects.has(excluded)).toBe(false);
    }
    // Never a table the report does not decide, or a record about a member of staff.
    for (const item of proposed) expect(NEVER_PROPOSED.has(item.table_name)).toBe(false);

    const report = await asOwner<{ mode: string }>(
      DEMO.tenantId,
      "SELECT mode FROM retention_report ORDER BY as_of DESC, id DESC LIMIT 1",
    );
    expect(report[0]?.mode).toBe("propose");
    const events = await audited("platform.retention.batch_proposed");
    const batches = await asOwner<{ id: string }>(
      DEMO.tenantId,
      "SELECT id FROM destruction_batch",
    );
    expect(events.map((e) => e.resource_id).sort()).toEqual(batches.map((b) => b.id).sort());
    // Ids, class and counts only: no record or subject id in the audit trail.
    for (const e of events) expect(JSON.stringify(e.scope)).not.toMatch(UUID);
    // The other organisation's flags are off.
    const other = await asOwner<{ n: number }>(
      OTHER.tenantId,
      "SELECT count(*)::int AS n FROM destruction_batch",
    );
    expect(other[0]?.n).toBe(0);
  });

  it("proposes no second batch for a class while one is proposed", async () => {
    const [{ n } = { n: 0 }] = await asOwner<{ n: number }>(
      DEMO.tenantId,
      "SELECT count(*)::int AS n FROM destruction_batch_item",
    );
    const before = await fingerprint();
    expect(await sweep(FAR)).toBe(1);
    expect(await fingerprint()).toEqual(before);
    expect((await items()).length).toBe(n);
  });

  it("lists batches and their items a page at a time, audited", async () => {
    const list = await json<DestructionBatchList>(
      await as("owner", "/v1/retention/batches?status=proposed&limit=1"),
    );
    expect(list.items).toHaveLength(1);
    const batch = list.items[0] as DestructionBatch;
    expect(batch).toMatchObject({ status: "proposed", version: 1, cancelledAt: null });
    const first = await json<DestructionBatchItemList>(
      await as("owner", `/v1/retention/batches/${batch.id}/items?limit=1`),
    );
    expect(first.batch.id).toBe(batch.id);
    expect(first.items).toHaveLength(1);
    if (batch.itemCount > 1) {
      expect(first.nextCursor).toBe(first.items[0]?.id);
      const second = await json<DestructionBatchItemList>(
        await as(
          "owner",
          `/v1/retention/batches/${batch.id}/items?limit=1&cursor=${first.nextCursor}`,
        ),
      );
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    }
    expect(
      (await as("owner", "/v1/retention/batches/0194d000-0000-7000-8000-00000000dead/items"))
        .status,
    ).toBe(404);
    const viewed = await audited("platform.retention.batch_viewed");
    expect(viewed.at(-1)?.resource_id).toBe(batch.id);
    expect((await audited("platform.retention.batches_listed")).length).toBeGreaterThan(0);
  });

  it("refuses anyone without platform.retention.manage tenant-wide, and other organisations", async () => {
    for (const user of ["carer", "nurse", "manager"] as const) {
      const refused = await as(user, "/v1/retention/batches");
      expect(refused.status).toBe(403);
      expect((await json<ProblemDetails>(refused)).code).toBeTruthy();
    }
    expect((await as("owner", "/v1/retention/batches", {}, OTHER.tenantId)).status).toBe(403);
    expect((await as("rae", "/v1/retention/batches", {}, DEMO.tenantId)).status).toBe(403);
  });

  it("refuses both lists without a fresh step-up", async () => {
    const [batch] = await asOwner<{ id: string }>(
      DEMO.tenantId,
      "SELECT id FROM destruction_batch LIMIT 1",
    );
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      for (const path of ["/v1/retention/batches", `/v1/retention/batches/${batch?.id}/items`]) {
        const refused = await as("owner", path);
        expect(refused.status).toBe(403);
        expect((await json<ProblemDetails>(refused)).code).toBe("step_up_required");
      }
    } finally {
      await ageSession(auth, session, 0);
    }
  });

  it("never shows or cancels one organisation's batch for another's holder", async () => {
    // Rae manages the other organisation and is given platform.retention.manage there.
    await asOwner(
      OTHER.tenantId,
      `WITH r AS (INSERT INTO role (key, name, scope_kind, permissions)
         VALUES ('records', 'Records', 'tenant', '{platform.retention.manage}') RETURNING id)
       INSERT INTO role_assignment (tenant_user_id, role_id, location_id) SELECT $1, r.id, NULL FROM r`,
      [OTHER.managerId],
    );
    expect((await as("rae", "/v1/retention/batches", {}, OTHER.tenantId)).status).toBe(200);
    const [batch] = await asOwner<{ id: string; version: number; status: string }>(
      DEMO.tenantId,
      "SELECT id, version, status FROM destruction_batch WHERE status = 'proposed' LIMIT 1",
    );
    const path = `/v1/retention/batches/${batch?.id}`;
    expect((await as("rae", `${path}/items`, {}, OTHER.tenantId)).status).toBe(404);
    const cancel = await as(
      "rae",
      `${path}/cancel`,
      { method: "POST", body: { expectedVersion: batch?.version, reason: "other" } },
      OTHER.tenantId,
    );
    expect(cancel.status).toBe(404);
    const [after] = await asOwner<{ version: number; status: string }>(
      DEMO.tenantId,
      "SELECT version, status FROM destruction_batch WHERE id = $1",
      [batch?.id],
    );
    expect(after).toEqual({ version: batch?.version, status: batch?.status });
  });

  it("cancels a proposed batch with step-up, its version and a reason code, once", async () => {
    const list = await json<DestructionBatchList>(
      await as("owner", "/v1/retention/batches?status=proposed"),
    );
    const batch = list.items[0] as DestructionBatch;
    const path = `/v1/retention/batches/${batch.id}/cancel`;
    const cancel = (body: unknown) => as("owner", path, { method: "POST", body });

    // Without a fresh step-up.
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const refused = await cancel({ expectedVersion: 1, reason: "rule_under_review" });
      expect(refused.status).toBe(403);
      expect((await json<ProblemDetails>(refused)).code).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
    // Free text is not a reason code.
    expect((await cancel({ expectedVersion: 1, reason: "Ada asked us to" })).status).toBe(422);
    // A stale version.
    expect((await cancel({ expectedVersion: 7, reason: "rule_under_review" })).status).toBe(409);

    const before = await fingerprint();
    const done = await cancel({ expectedVersion: 1, reason: "rule_under_review" });
    expect(done.status).toBe(200);
    expect(await json<DestructionBatch>(done)).toMatchObject({
      status: "cancelled",
      cancelReason: "rule_under_review",
      cancelledBy: DEMO.users.owner.id,
      version: 2,
    });
    // Cancelling destroys and restores nothing: every record stays as it was. The history
    // gains only the batch's own earlier version.
    const after = await fingerprint();
    const versions = `${DEMO.tenantId}:record_version`;
    expect({ ...after, [versions]: "" }).toEqual({ ...before, [versions]: "" });
    const history = await asOwner<{ table_name: string }>(
      DEMO.tenantId,
      "SELECT table_name FROM record_version WHERE record_id = $1",
      [batch.id],
    );
    expect(history.map((r) => r.table_name)).toEqual(["destruction_batch"]);
    // Decided: a second cancel is refused.
    expect((await cancel({ expectedVersion: 2, reason: "other" })).status).toBe(409);
    const cancelled = await audited("platform.retention.batch_cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.resource_id).toBe(batch.id);
    expect(JSON.stringify(cancelled[0]?.scope)).not.toMatch(UUID);

    // Its class may be proposed again by the next sweep, as a new batch.
    expect(await sweep(FAR)).toBe(1);
    const again = await json<DestructionBatchList>(
      await as("owner", "/v1/retention/batches?status=proposed"),
    );
    expect(again.items.map((b) => b.recordClass)).toContain(batch.recordClass);
  });
});
