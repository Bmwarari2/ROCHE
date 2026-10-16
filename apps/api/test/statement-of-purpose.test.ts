import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escalateStatementsOfPurpose } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * The statement of purpose through the API (quality.md rules 11 to 15; QUAL-009): the baseline,
 * a revision approved by someone who did not write it, the regulation 12(3) clock with its
 * overdue alert told once, and the CQC notification recorded by a holder of
 * safety.notification.submit.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const URL = "/v1/statement-of-purpose/versions";

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

const content = (aims: string) => ({
  aimsAndObjectives: aims,
  serviceKinds: ["Care home service without nursing"],
  needsMet: "Older people, including people living with dementia.",
  provider: {
    fullName: "Harbour Care Example Ltd",
    businessAddress: "1 Example Street, Exampletown",
    businessPhone: "01632 960000",
    email: null,
  },
  registeredManagers: [],
  serviceAddress: "1 Example Street, Exampletown",
  consentsToEmailService: false,
  serviceEmail: null,
  legalStatus: "limited_company",
  legalStatusDetail: null,
  locations: [
    {
      id: DEMO.locationId,
      name: "Harbour House",
      address: "1 Example Street",
      cqcLocationId: null,
    },
  ],
});

interface Version {
  id: string;
  kind: string;
  state: string;
  version: number;
  missing: string[];
  notification: { state: string; dueAt: string | null; late: boolean };
}

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("statement of purpose versions", () => {
  let baseline: Version;
  let revision: Version;

  it("drafts the baseline; a care worker cannot", async () => {
    expect((await as("carer", URL, { method: "POST", body: {} })).status).toBe(403);
    expect((await as("manager", URL, { method: "POST", body: {} })).status).toBe(422);
    const response = await as("manager", URL, {
      method: "POST",
      body: { content: content("To give people a safe and happy home for life.") },
    });
    expect(response.status).toBe(201);
    baseline = (await response.json()) as Version;
    expect(baseline).toMatchObject({ kind: "baseline", state: "draft", missing: [] });
    const second = await as("manager", URL, {
      method: "POST",
      body: { content: content("Another draft at the same time as the first.") },
    });
    expect(second.status).toBe(409);
  });

  it("is never approved by its author; another approver approves it with no notification due", async () => {
    const own = await as("manager", `${URL}/${baseline.id}/approve`, {
      method: "POST",
      body: { version: baseline.version },
    });
    expect(own.status).toBe(403);
    const response = await as("owner", `${URL}/${baseline.id}/approve`, {
      method: "POST",
      body: { version: baseline.version },
    });
    expect(response.status).toBe(200);
    baseline = (await response.json()) as Version;
    expect(baseline).toMatchObject({ state: "approved", notification: { state: "not_required" } });
  });

  it("starts a revision from the current version, refuses approving it unchanged, then approves the change with the clock started", async () => {
    const drafted = await as("manager", URL, { method: "POST", body: {} });
    revision = (await drafted.json()) as Version;
    expect(revision.kind).toBe("revision");
    const unchanged = await as("owner", `${URL}/${revision.id}/approve`, {
      method: "POST",
      body: { version: revision.version },
    });
    expect(unchanged.status).toBe(409);
    const edited = await as("manager", `${URL}/${revision.id}`, {
      method: "PUT",
      body: {
        content: content("To give people a safe, kind and happy home for life."),
        version: revision.version,
      },
    });
    revision = (await edited.json()) as Version;
    const changes = (await (await as("owner", `${URL}/${revision.id}/changes`)).json()) as {
      sections: { change: string; lines: string[] }[];
    };
    expect(changes.sections.some((s) => s.change === "changed")).toBe(true);
    const approved = await as("owner", `${URL}/${revision.id}/approve`, {
      method: "POST",
      body: { version: revision.version },
    });
    expect(approved.status).toBe(200);
    revision = (await approved.json()) as Version;
    expect(revision.notification.state).toBe("due");
    const [old] = await sql<{ state: string }>(
      "SELECT state FROM statement_of_purpose_version WHERE id = $1",
      [baseline.id],
    );
    expect(old?.state).toBe("superseded");
    const events = await sql<{ event_type: string }>(
      "SELECT event_type FROM outbox_event WHERE aggregate_id = $1",
      [revision.id],
    );
    expect(events.map((e) => e.event_type)).toEqual(["quality.statement_of_purpose.approved"]);
  });

  it("tells the holders of safety.notification.submit once when the revision is overdue", async () => {
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    expect(await escalateStatementsOfPurpose(deps)).toBe(0);
    const later = new Date(Date.now() + 30 * 86_400_000);
    expect(await escalateStatementsOfPurpose(deps, later)).toBe(1);
    expect(await escalateStatementsOfPurpose(deps, later)).toBe(0);
    const told = await sql<{ recipient_tenant_user_id: string }>(
      "SELECT recipient_tenant_user_id FROM notification WHERE source_id = $1 ORDER BY 1",
      [revision.id],
    );
    expect(told.map((t) => t.recipient_tenant_user_id).sort()).toEqual(
      [DEMO.users.owner.id, DEMO.users.manager.id].sort(),
    );
    const events = await sql<{ event_type: string }>(
      "SELECT event_type FROM outbox_event WHERE aggregate_id = $1",
      [revision.id],
    );
    expect(events.map((e) => e.event_type)).toContain(
      "quality.statement_of_purpose.notification_overdue",
    );
  });

  it("records the notification once, by a holder of safety.notification.submit, and stops the alerts", async () => {
    const body = { sentAt: new Date().toISOString(), evidence: "CQC portal reference EX-0001" };
    expect(
      (await as("carer", `${URL}/${revision.id}/notification`, { method: "POST", body })).status,
    ).toBe(403);
    const future = await as("manager", `${URL}/${revision.id}/notification`, {
      method: "POST",
      body: { ...body, sentAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(future.status).toBe(422);
    const response = await as("manager", `${URL}/${revision.id}/notification`, {
      method: "POST",
      body,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Version).notification).toMatchObject({
      state: "notified",
      late: false,
    });
    const open = await sql<{ id: string }>(
      "SELECT id FROM notification WHERE source_id = $1 AND acknowledged_at IS NULL",
      [revision.id],
    );
    expect(open).toEqual([]);
    const again = await as("manager", `${URL}/${revision.id}/notification`, {
      method: "POST",
      body,
    });
    expect(again.status).toBe(409);
  });
});
