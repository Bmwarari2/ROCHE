import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { addUkDays, addUkMonths, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remindPolicies } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * The policy library and read-and-sign through the API (quality.md section 18; QUAL-008; hazard
 * HZ-128; plan slice 25): who creates and publishes, the second reviewer, the version in force
 * only in the list, superseded versions naming their replacement, minor and major changes against
 * signatures, signing only the version in force, reminders once per interval completed by signing
 * and cancelled by a newer version, review tasks and retirement.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const CARER = DEMO.users.carer.id;
const MANAGER = DEMO.users.manager.id;
const inMonths = (months: number) => ukIsoDate(addUkMonths(new Date(), months));

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

interface Version {
  id: string;
  version: number;
  versionNumber: number;
  state: string;
  supersededBy: string | null;
}
interface Policy {
  id: string;
  version: number;
  inForce: Version | null;
  versions: Version[];
  mustSign: boolean;
  signed: boolean;
}

let fire: Policy;
const deps = () => ({
  workerPool: h.db.pool("harbour_worker"),
  appDb: createDatabase(h.db.pool("harbour_app")),
  logger: createLogger("silent"),
});
const draftOf = (p: Policy) => p.versions.find((v) => v.state === "draft");
const get = async (who: string) =>
  (await (await as(who, `/v1/policies/${fire.id}`)).json()) as Policy;
const publishDraft = async (who: string) => {
  const current = await get("manager");
  const draft = draftOf(current);
  return as(who, `/v1/policies/${fire.id}/versions/${draft?.id}/publish`, {
    method: "POST",
    body: { expectedVersion: draft?.version },
  });
};
const newDraft = (change: "minor" | "major", summary: string) =>
  as("manager", `/v1/policies/${fire.id}/versions`, {
    method: "POST",
    body: { change, changeSummary: summary, reviewDueOn: inMonths(6) },
  });
const signTasks = () =>
  sql<{ status: string; assignee_tenant_user_id: string; source_id: string }>(
    "SELECT status, assignee_tenant_user_id, source_id FROM task WHERE kind = 'quality.policy_read_and_sign' ORDER BY created_at",
  );

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("creating and publishing (quality.md rule 25)", () => {
  const create = (who: string) =>
    as(who, "/v1/policies", {
      method: "POST",
      body: {
        policyKey: "fire_safety",
        title: "Fire safety",
        requireSecondReviewer: true,
        firstVersion: {
          changeSummary: "First issue",
          body: "Evacuate by the nearest safe exit. Never use the lift.",
          documentId: null,
          roles: ["care_worker"],
          reviewDueOn: inMonths(6),
        },
      },
    });

  it("creates a policy for holders of quality.policy.manage only", async () => {
    expect((await create("carer")).status).toBe(403);
    const created = await create("manager");
    expect(created.status).toBe(201);
    fire = (await created.json()) as Policy;
    expect(fire.inForce).toBeNull();
    expect((await create("manager")).status).toBe(409);
  });

  it("hides a policy with only a draft from staff who do not manage policies", async () => {
    expect((await as("carer", `/v1/policies/${fire.id}`)).status).toBe(404);
  });

  it("is never published by its author when the policy needs a second reviewer", async () => {
    const own = await publishDraft("manager");
    expect(own.status).toBe(403);
    expect(((await own.json()) as { code: string }).code).toBe("second_reviewer_required");
    const ok = await publishDraft("owner");
    expect(ok.status).toBe(200);
    fire = (await ok.json()) as Policy;
    expect(fire.inForce?.versionNumber).toBe(1);
  });
});

describe("hazard HZ-128 read-and-sign (quality.md rules 26 and 27)", () => {
  it("hazard HZ-128 asks holders of the listed roles to sign the version in force", async () => {
    const list = (await (await as("carer", "/v1/policies")).json()) as {
      items: { id: string; mustSign: boolean; signed: boolean }[];
    };
    expect(list.items.find((i) => i.id === fire.id)).toMatchObject({
      mustSign: true,
      signed: false,
    });
    const mine = (await (await as("carer", "/v1/me/policies")).json()) as {
      items: { policyId: string }[];
    };
    expect(mine.items.map((i) => i.policyId)).toEqual([fire.id]);
    const status = await as(
      "manager",
      `/v1/policies/${fire.id}/versions/${fire.inForce?.id}/read-and-sign`,
    );
    const body = (await status.json()) as { outstanding: { memberId: string }[] };
    expect(body.outstanding.map((o) => o.memberId)).toContain(CARER);
    expect(
      (await as("carer", `/v1/policies/${fire.id}/versions/${fire.inForce?.id}/read-and-sign`))
        .status,
    ).toBe(403);
  });

  it("hazard HZ-128 tells the outstanding member at once, then once per interval", async () => {
    expect(await remindPolicies(deps())).toBe(1);
    expect(await remindPolicies(deps())).toBe(0);
    const [task] = await signTasks();
    expect(task).toMatchObject({
      status: "open",
      assignee_tenant_user_id: CARER,
      source_id: fire.inForce?.id,
    });
    expect(await remindPolicies(deps(), addUkDays(new Date(), 8))).toBe(1);
    expect((await signTasks()).map((t) => t.status)).toEqual(["cancelled", "open"]);
  });

  it("hazard HZ-128 completes a reminder only by signing, never by a task transition", async () => {
    const [open] = await sql<{ id: string; version: number }>(
      "SELECT id, version FROM task WHERE kind = 'quality.policy_read_and_sign' AND status = 'open'",
    );
    for (const who of ["carer", "manager"]) {
      const moved = await as(who, `/v1/tasks/${open?.id}/transition`, {
        method: "POST",
        body: { to: "done", version: open?.version },
      });
      // The carer is refused; a manager elsewhere cannot even see it.
      expect([403, 404]).toContain(moved.status);
    }
    const [still] = await sql<{ status: string }>("SELECT status FROM task WHERE id = $1", [
      open?.id,
    ]);
    expect(still?.status).toBe("open");
  });

  it("hazard HZ-128 completes the reminder when the member signs", async () => {
    const signed = await as(
      "carer",
      `/v1/policies/${fire.id}/versions/${fire.inForce?.id}/signatures`,
      {
        method: "POST",
      },
    );
    expect(signed.status).toBe(200);
    expect((await signed.json()) as Policy).toMatchObject({ mustSign: true, signed: true });
    expect((await signTasks()).map((t) => t.status)).toEqual(["cancelled", "done"]);
    const again = await as(
      "carer",
      `/v1/policies/${fire.id}/versions/${fire.inForce?.id}/signatures`,
      {
        method: "POST",
      },
    );
    expect(again.status).toBe(409);
  });

  it("hazard HZ-128 keeps signatures after a minor change and names the replacement", async () => {
    const first = fire.inForce;
    expect((await newDraft("minor", "Corrected the assembly point")).status).toBe(200);
    expect((await publishDraft("owner")).status).toBe(200);
    const asCarer = await get("carer");
    expect(asCarer.inForce?.versionNumber).toBe(2);
    expect(asCarer).toMatchObject({ mustSign: true, signed: true });
    const old = asCarer.versions.find((v) => v.id === first?.id);
    expect(old).toMatchObject({ state: "superseded", supersededBy: asCarer.inForce?.id });
    const list = (await (await as("carer", "/v1/policies")).json()) as {
      items: { id: string; inForce: { id: string } | null }[];
    };
    expect(list.items.find((i) => i.id === fire.id)?.inForce?.id).toBe(asCarer.inForce?.id);
    fire = asCarer;
  });

  it("hazard HZ-128 refuses a signature on a superseded version", async () => {
    const old = fire.versions.find((v) => v.state === "superseded");
    const refused = await as("carer", `/v1/policies/${fire.id}/versions/${old?.id}/signatures`, {
      method: "POST",
    });
    expect(refused.status).toBe(409);
  });

  it("hazard HZ-128 asks everyone again after a major change", async () => {
    expect((await newDraft("major", "New evacuation procedure")).status).toBe(200);
    expect((await publishDraft("owner")).status).toBe(200);
    const asCarer = await get("carer");
    expect(asCarer.inForce?.versionNumber).toBe(3);
    expect(asCarer).toMatchObject({ mustSign: true, signed: false });
    fire = asCarer;
  });

  it("hazard HZ-128 cancels the reminders for a version when a newer one is published", async () => {
    const v3 = fire.inForce?.id;
    expect(await remindPolicies(deps())).toBe(1);
    expect((await newDraft("minor", "Clarified the night procedure")).status).toBe(200);
    expect((await publishDraft("owner")).status).toBe(200);
    const forV3 = (await signTasks()).filter((t) => t.source_id === v3).map((t) => t.status);
    expect(forV3).toEqual(["cancelled"]);
    fire = await get("carer");
    expect(fire.inForce?.versionNumber).toBe(4);
  });
});

describe("hazard HZ-128 review dates (quality.md rule 28)", () => {
  it("hazard HZ-128 raises one review task for the author when due soon and one when overdue", async () => {
    const dueSoon = addUkDays(addUkMonths(new Date(), 6), -10);
    await remindPolicies(deps(), dueSoon);
    await remindPolicies(deps(), dueSoon);
    const overdue = addUkDays(addUkMonths(new Date(), 6), 2);
    await remindPolicies(deps(), overdue);
    const review = await sql<{
      assignee_tenant_user_id: string;
      details: { reviewStatus: string };
    }>(
      "SELECT assignee_tenant_user_id, details FROM task WHERE kind = 'quality.policy_review' ORDER BY created_at",
    );
    expect(review.map((r) => r.details.reviewStatus)).toEqual(["due_soon", "overdue"]);
    expect(review.every((r) => r.assignee_tenant_user_id === MANAGER)).toBe(true);
  });

  it("refuses a review date further away than the organisation allows", async () => {
    await as("manager", `/v1/policies/${fire.id}/versions`, {
      method: "POST",
      body: { change: "minor", changeSummary: "Typo", reviewDueOn: inMonths(120) },
    });
    const refused = await publishDraft("owner");
    expect(refused.status).toBe(422);
  });

  it("hazard HZ-128 refuses roles the organisation does not have, so someone is always asked", async () => {
    const draft = draftOf(await get("manager"));
    await as("manager", `/v1/policies/${fire.id}/versions/${draft?.id}`, {
      method: "PATCH",
      body: {
        expectedVersion: draft?.version,
        change: "minor",
        changeSummary: "Typo",
        body: "Evacuate by the nearest safe exit.",
        documentId: null,
        roles: ["care_workers"],
        reviewDueOn: inMonths(6),
      },
    });
    const refused = await publishDraft("owner");
    expect(refused.status).toBe(422);
  });
});

describe("retiring a policy", () => {
  it("hazard HZ-128 retires it with a reason, ends its reminders and takes it out of the list", async () => {
    // The review runs above already reminded the carer about version 4.
    expect((await signTasks()).filter((t) => t.status === "open").length).toBeGreaterThanOrEqual(1);
    const current = await get("manager");
    const retired = await as("manager", `/v1/policies/${fire.id}/retire`, {
      method: "POST",
      body: { expectedVersion: current.version, reason: "Replaced by the emergency plan" },
    });
    expect(retired.status).toBe(200);
    expect(
      ((await retired.json()) as Policy).versions.find((v) => v.versionNumber === 4)?.state,
    ).toBe("retired");
    const list = (await (await as("carer", "/v1/policies")).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).not.toContain(fire.id);
    const open = (await signTasks()).filter(
      (t) => t.status === "open" || t.status === "in_progress",
    );
    expect(open).toEqual([]);
  });
});

describe("hazard HZ-128 policy PDFs (quality.md section 18.3)", () => {
  const PDF = (n: number) =>
    new TextEncoder().encode(`%PDF-1.7\n% ${n}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);
  const upload = async (n: number) => {
    const stored = await h.request(
      `/v1/documents?category=organisation_document&title=Medicines%20policy%20${n}`,
      {
        method: "POST",
        token: h.tokens.manager,
        tenant: DEMO.tenantId,
        raw: { bytes: PDF(n), contentType: "application/pdf" },
      },
    );
    expect(stored.status).toBe(201);
    return ((await stored.json()) as { id: string }).id;
  };
  let meds: Policy;
  let first: string;

  it("hazard HZ-128 serves a policy's PDF by the general routes only while it is in force", async () => {
    first = await upload(1);
    const created = await as("manager", "/v1/policies", {
      method: "POST",
      body: {
        policyKey: "medicines",
        title: "Medicines",
        requireSecondReviewer: false,
        firstVersion: {
          changeSummary: "First issue",
          body: null,
          documentId: first,
          roles: ["care_worker"],
          reviewDueOn: inMonths(6),
        },
      },
    });
    meds = (await created.json()) as Policy;
    expect((await as("carer", `/v1/documents/${first}/content`)).status).toBe(404);
    const draft = meds.versions[0];
    const published = await as("manager", `/v1/policies/${meds.id}/versions/${draft?.id}/publish`, {
      method: "POST",
      body: { expectedVersion: draft?.version },
    });
    expect(published.status).toBe(200);
    expect((await as("carer", `/v1/documents/${first}/content`)).status).toBe(200);
    expect(
      (
        await h.request(`/v1/documents/${first}/versions`, {
          method: "POST",
          token: h.tokens.manager,
          tenant: DEMO.tenantId,
          raw: { bytes: PDF(9), contentType: "application/pdf" },
        })
      ).status,
    ).toBe(409);
  });

  it("hazard HZ-128 serves a superseded PDF only through the library, saying it is superseded", async () => {
    const second = await upload(2);
    await as("manager", `/v1/policies/${meds.id}/versions`, {
      method: "POST",
      body: {
        change: "major",
        changeSummary: "New procedure",
        documentId: second,
        reviewDueOn: inMonths(6),
      },
    });
    const now = (await (await as("manager", `/v1/policies/${meds.id}`)).json()) as Policy;
    const draft = now.versions.find((v) => v.state === "draft");
    await as("manager", `/v1/policies/${meds.id}/versions/${draft?.id}/publish`, {
      method: "POST",
      body: { expectedVersion: draft?.version },
    });
    expect((await as("carer", `/v1/documents/${first}/content`)).status).toBe(404);
    const list = (await (
      await as("carer", "/v1/documents?category=organisation_document")
    ).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((i) => i.id)).not.toContain(first);
    const v1 = now.versions.find((v) => v.versionNumber === 1);
    const opened = await as("carer", `/v1/policies/${meds.id}/versions/${v1?.id}/document`);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("x-harbour-policy-state")).toBe("superseded");
    expect(opened.headers.get("x-harbour-policy-in-force")).toBe(draft?.id);
  });
});
