import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Outages through the API (operations.md rules 9 to 15 and section 5; OPS-028; hazard HZ-017):
 * declaring in the declarer's name, closing with the back-entry task, reconciling only after the
 * possible duplicates are reviewed and by someone who entered none of the paper records,
 * cancelling one declared in error, and correcting a start with a reason.
 */

let h: Harness;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const outagesUrl = (locationId: string = DEMO.locationId) => `/v1/locations/${locationId}/outages`;

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
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
  } finally {
    client.release();
  }
}

/** An instant `ms` ago, to the minute (a paper time has no seconds). */
const ago = (ms: number) => new Date(Math.floor((Date.now() - ms) / MINUTE) * MINUTE);

interface OutageBody {
  id: string;
  state: string;
  declaredBy: string;
  declaredLate: boolean;
  endedAt: string | null;
  backEntryDueAt: string | null;
  reconciledBy: string | null;
  version: number;
}

const declare = async (who: string, body: Record<string, unknown>, locationId?: string) =>
  as(who, outagesUrl(locationId), { method: "POST", body });

/** A care note about `personId` at the demo home, written by `createdBy`; a back-entry with `outageId`. */
async function note(personId: string, at: Date, createdBy: string, outageId?: string) {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, created_by,
       late_entry_reason, outage_id, paper_date, paper_time, paper_occurrence, paper_reference)
     VALUES ($1, $2, $3::timestamptz, 'personal_care', 'Assisted with a wash.', $4,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'downtime' END, $5::uuid,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE ($3::timestamptz AT TIME ZONE 'Europe/London')::date END,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE ($3::timestamptz AT TIME ZONE 'Europe/London')::time END,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'only' END,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'DT-001' END)
     RETURNING id`,
    [personId, DEMO.locationId, at, createdBy, outageId ?? null],
  );
  return row?.id as string;
}

let personId: string;

beforeAll(async () => {
  h = await createHarness();
  const [person] = await sql<{ id: string }>(
    "SELECT id FROM person WHERE location_id = $1 AND status = 'active' ORDER BY id LIMIT 1",
    [DEMO.locationId],
  );
  personId = person?.id as string;
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-017 outages at a location", () => {
  let open: OutageBody;

  it("declares an outage in the declarer's name, audited and announced, and lists it for anyone who can see someone there", async () => {
    const response = await declare("manager", {
      kind: "power",
      description: "Power cut, whole building",
      startedAt: ago(30 * MINUTE).toISOString(),
    });
    expect(response.status).toBe(201);
    open = (await response.json()) as OutageBody;
    expect(open).toMatchObject({
      state: "declared",
      declaredBy: DEMO.users.manager.id,
      declaredLate: false,
      endedAt: null,
    });
    const listed = await as("carer", outagesUrl());
    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as { items: { id: string }[] };
    expect(items.map((i) => i.id)).toContain(open.id);
    const [workflow] = await sql<{ state: string }>(
      "SELECT w.state FROM workflow_instance w JOIN outage o ON o.workflow_instance_id = w.id WHERE o.id = $1",
      [open.id],
    );
    expect(workflow?.state).toBe("declared");
    const events = await sql<{ event_type: string }>(
      "SELECT event_type FROM outbox_event WHERE aggregate_id = $1",
      [open.id],
    );
    expect(events.map((e) => e.event_type)).toEqual(["operations.outage.declared"]);
  });

  it("refuses an overlapping or future outage, and anyone without operations.downtime.manage where it is", async () => {
    const overlapping = await declare("owner", {
      kind: "network",
      description: "Internet down, whole site",
      startedAt: ago(10 * MINUTE).toISOString(),
    });
    expect(overlapping.status).toBe(422);
    expect(JSON.stringify(await overlapping.json())).toMatch(/already open/);
    const future = await declare("manager", {
      kind: "power",
      description: "Power cut, whole building",
      startedAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    expect(future.status).toBe(422);
    const body = {
      kind: "power",
      description: "Power cut, whole building",
      startedAt: ago(50 * HOUR).toISOString(),
      endedAt: ago(49 * HOUR).toISOString(),
    };
    expect((await declare("carer", body)).status).toBe(403);
    expect((await declare("manager", body, LODGE.locationId)).status).toBe(404);
  });

  it("hazard HZ-017 closes with the back-entry task, and reconciles only after review by someone who entered none of the paper records", async () => {
    const at = ago(20 * MINUTE);
    const paper = await note(personId, at, DEMO.users.manager.id, open.id);
    const digital = await note(personId, new Date(at.getTime() + 3 * MINUTE), DEMO.users.carer.id);
    // Entered while the outage was open; the true end given on closing is earlier (H-207).
    const late = await note(personId, ago(3 * MINUTE), DEMO.users.carer.id, open.id);
    const stale = await as("manager", `/v1/outages/${open.id}/close`, {
      method: "POST",
      body: { endedAt: ago(5 * MINUTE).toISOString(), version: open.version + 1 },
    });
    expect(stale.status).toBe(409);
    const closed = await as("manager", `/v1/outages/${open.id}/close`, {
      method: "POST",
      body: { endedAt: ago(5 * MINUTE).toISOString(), version: open.version },
    });
    expect(closed.status).toBe(200);
    const after = (await closed.json()) as OutageBody;
    expect(after.state).toBe("closed");
    const tasks = await sql<{ due_at: Date; status: string }>(
      "SELECT due_at, status FROM task WHERE kind = 'operations.outage_back_entry' AND source_id = $1",
      [open.id],
    );
    expect(tasks).toEqual([{ due_at: new Date(after.backEntryDueAt ?? ""), status: "open" }]);

    const view = await as("manager", `/v1/outages/${open.id}/reconciliation`);
    expect(view.status).toBe(200);
    const summary = (await view.json()) as {
      backEntries: number;
      duplicateGroups: string[][];
      enteredByYou: boolean;
      outsideWindowEntryIds: string[];
      blockers: string[];
    };
    expect(summary.backEntries).toBe(2);
    expect(summary.duplicateGroups.map((g) => [...g].sort())).toEqual([[paper, digital].sort()]);
    expect(summary.enteredByYou).toBe(true);
    expect(summary.outsideWindowEntryIds).toEqual([late]);
    expect(summary.blockers.join(" ")).toMatch(/did not enter the paper records/);

    const reconcile = (who: string, reviewedEntryIds: string[]) =>
      as(who, `/v1/outages/${open.id}/reconcile`, {
        method: "POST",
        body: {
          statement: "All 1 forms entered and checked",
          reviewedEntryIds,
          version: after.version,
        },
      });
    expect((await reconcile("manager", [paper, digital])).status).toBe(422);
    const unreviewed = await reconcile("owner", []);
    expect(unreviewed.status).toBe(422);
    expect(JSON.stringify(await unreviewed.json())).toMatch(/recorded twice/);
    const outside = await reconcile("owner", [paper, digital]);
    expect(outside.status).toBe(422);
    expect(JSON.stringify(await outside.json())).toMatch(/with a time outside it/);
    const done = await reconcile("owner", [paper, digital, late]);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({
      state: "reconciled",
      reconciledBy: DEMO.users.owner.id,
    });
    const [task] = await sql<{ status: string }>(
      "SELECT status FROM task WHERE kind = 'operations.outage_back_entry' AND source_id = $1",
      [open.id],
    );
    expect(task?.status).toBe("done");
    const audited = await sql<{ action: string }>(
      "SELECT action FROM audit_event WHERE resource_id = $1 ORDER BY occurred_at",
      [open.id],
    );
    expect(audited.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "operations.outage.declared",
        "operations.outage.closed",
        "operations.outage.reconciliation_viewed",
        "operations.outage.reconciled",
      ]),
    );
  });

  it("corrects a start with a reason, and cancels an outage declared in error unless a paper record cites it", async () => {
    const declared = await declare("manager", {
      kind: "network",
      description: "Internet down, whole site",
      startedAt: ago(10 * HOUR).toISOString(),
      endedAt: ago(9 * HOUR).toISOString(),
    });
    expect(declared.status).toBe(201);
    const cited = (await declared.json()) as OutageBody;
    const corrected = await as("manager", `/v1/outages/${cited.id}/correct`, {
      method: "POST",
      body: {
        startedAt: ago(10 * HOUR + 30 * MINUTE).toISOString(),
        endedAt: ago(9 * HOUR).toISOString(),
        reason: "The router failed half an hour earlier",
        version: cited.version,
      },
    });
    expect(corrected.status).toBe(200);
    const version = ((await corrected.json()) as OutageBody).version;
    await note(personId, ago(9 * HOUR + 30 * MINUTE), DEMO.users.carer.id, cited.id);
    const refused = await as("manager", `/v1/outages/${cited.id}/cancel`, {
      method: "POST",
      body: { reason: "Declared in error", version },
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toMatch(/cannot be cancelled once a paper record/);

    const wrong = await declare("manager", {
      kind: "other",
      description: "Declared at the wrong home",
      startedAt: ago(20 * HOUR).toISOString(),
      endedAt: ago(19 * HOUR).toISOString(),
    });
    const wrongBody = (await wrong.json()) as OutageBody;
    const cancelled = await as("manager", `/v1/outages/${wrongBody.id}/cancel`, {
      method: "POST",
      body: { reason: "Declared at the wrong home", version: wrongBody.version },
    });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as OutageBody).state).toBe("cancelled");
  });
});
