import { createDatabase, withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raiseCaseworkDsarTasks } from "../src/services/casework-dsar";
import { createHarness, type Harness } from "./support/harness";

/**
 * Employee relations casework through the API (workforce.md section 2c, rules 15 to 18 and
 * section 5; WORK-010; plan slice 39; ADR-0089): only a holder of the silo permission opens a
 * case; only the members named on it read or act on it, the owner and the Registered Manager
 * included; a disciplinary case from opening to an appeal decided, with a hearing that needs the
 * Acas steps, a suspension that must end and a DBS referral decision before closing; refusals
 * audited; audit events with ids and codes only.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const json = async <T>(response: Response) => (await response.json()) as T;

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
  } finally {
    client.release();
  }
}

interface Detail {
  case: {
    id: string;
    stage: string;
    version: number;
    myRoles: string[];
    subjectRegistered: boolean;
    outcome: string | null;
    appealOutcome: string | null;
    suspended: boolean;
    closedReason: string | null;
    retentionClass: string;
  };
  referrals: { dbs: { due: boolean; decision: string | null } };
  members: { id: string; tenantUserId: string; role: string; version: number }[];
  hearings: { id: string; state: string; version: number }[];
  timeline: { kind: string; body: string | null }[];
}

const SUMMARY = "Concerns about medicines records on two night shifts";
let agencyId = "";
/** The quality lead, who is also the caseworker (see beforeAll). */
const QUALITY = "0194d000-0000-7000-8000-000000000305";
let caseId = "";
let detail: Detail;

const move = async (who: string, body: Record<string, unknown>) =>
  as(who, `/v1/workforce/cases/${caseId}/move`, {
    method: "POST",
    body: { expectedVersion: detail.case.version, ...body },
  });
const keep = async (response: Response, status = 200) => {
  expect(response.status, await response.clone().text()).toBe(status);
  detail = await json<Detail>(response);
  return detail;
};
const name = (tenantUserId: string, role: string, independenceException: string | null = null) =>
  as("quality", `/v1/workforce/cases/${caseId}/members`, {
    method: "POST",
    body: { tenantUserId, role, independenceException },
  });

beforeAll(async () => {
  h = await createHarness();
  // The quality lead is also the organisation's employee relations caseworker.
  await sql(
    `INSERT INTO role_assignment (tenant_user_id, role_id)
     SELECT $1, id FROM role WHERE key = 'employee_relations_lead'`,
    ["0194d000-0000-7000-8000-000000000305"],
  );
  const [agency] = await sql<{ id: string }>(
    "SELECT id FROM tenant_user WHERE email = 'agency@example.invalid'",
  );
  agencyId = agency?.id ?? "";
  // Agency Ash is also employed here as a care worker, so they are a colleague to name (an
  // agency role alone is not: slice 58).
  await sql(
    `INSERT INTO role_assignment (tenant_user_id, role_id)
     SELECT $1, id FROM role WHERE key = 'care_worker'`,
    [agencyId],
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("opening a case (the silo permission)", () => {
  it("refuses the owner and the Registered Manager, who never hold it, and audits it", async () => {
    for (const who of ["owner", "manager"]) {
      const response = await as(who, "/v1/workforce/cases", {
        method: "POST",
        body: {
          caseType: "grievance",
          subjectTenantUserId: DEMO.users.carer.id,
          summary: SUMMARY,
          openedOn: "2026-11-02",
        },
      });
      expect(response.status).toBe(403);
    }
    const denied = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE action = 'workforce.casework.manage' AND outcome = 'denied'`,
    );
    expect(denied[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("refuses a case about oneself", async () => {
    const response = await as("quality", "/v1/workforce/cases", {
      method: "POST",
      body: {
        caseType: "grievance",
        subjectTenantUserId: "0194d000-0000-7000-8000-000000000305",
        summary: SUMMARY,
        openedOn: "2026-11-02",
      },
    });
    expect(response.status).toBe(422);
  });

  it("opens a disciplinary case with the caseworker as its case manager", async () => {
    await keep(
      await as("quality", "/v1/workforce/cases", {
        method: "POST",
        body: {
          caseType: "disciplinary",
          subjectTenantUserId: DEMO.users.carer.id,
          summary: SUMMARY,
          openedOn: "2026-11-02",
        },
      }),
      201,
    );
    caseId = detail.case.id;
    expect(detail.case).toMatchObject({ stage: "open", myRoles: ["case_manager"] });
    expect(detail.timeline.map((e) => e.kind)).toEqual(["opened"]);
  });
});

describe("only the case's members read it (ADR-0089)", () => {
  it("is not found for the owner, the Registered Manager or the member of staff it is about", async () => {
    for (const who of ["owner", "manager", "carer", "agency"]) {
      expect((await as(who, `/v1/workforce/cases/${caseId}`)).status, who).toBe(404);
      const list = await json<{ items: unknown[] }>(await as(who, "/v1/workforce/cases"));
      expect(list.items, who).toEqual([]);
    }
  });

  it("is not found from another organisation", async () => {
    const response = await h.request(`/v1/workforce/cases/${caseId}`, {
      token: h.tokens.rae,
      tenant: DEMO.tenantId,
    });
    expect([403, 404]).toContain(response.status);
  });

  it("is read by a member once named, never the member of staff it is about", async () => {
    expect((await name(DEMO.users.carer.id, "note_taker")).status).toBe(422);
    await keep(await name(agencyId, "investigator"));
    const seen = await keep(await as("agency", `/v1/workforce/cases/${caseId}`));
    expect(seen.case.myRoles).toEqual(["investigator"]);
    const list = await json<{ items: { id: string }[] }>(await as("agency", "/v1/workforce/cases"));
    expect(list.items.map((i) => i.id)).toEqual([caseId]);
  });

  it("lets nobody but a case manager name members, and nobody name themselves", async () => {
    const byInvestigator = await as("agency", `/v1/workforce/cases/${caseId}/members`, {
      method: "POST",
      body: { tenantUserId: DEMO.users.owner.id, role: "hearing_chair" },
    });
    expect(byInvestigator.status).toBe(403);
    const self = await name("0194d000-0000-7000-8000-000000000305", "note_taker");
    expect(self.status).toBe(422);
  });
});

describe("MFA for every case member", () => {
  it("refuses a named member who has not used a second factor", async () => {
    await keep(await name(DEMO.users.nurse.id, "note_taker"));
    const response = await as("nurse", `/v1/workforce/cases/${caseId}`);
    expect(response.status).toBe(403);
    expect((await json<{ code: string }>(response)).code).toBe("mfa_enrolment_required");
  });
});

describe("a disciplinary case to an appeal decided (rules 15 to 18)", () => {
  it("investigates, with a suspension kept under review", async () => {
    await keep(await move("quality", { to: "investigation", on: "2026-11-03" }));
    expect(detail.case.stage).toBe("investigation");
    const refused = await as("quality", `/v1/workforce/cases/${caseId}/suspension`, {
      method: "PUT",
      body: {
        expectedVersion: detail.case.version,
        kind: "start",
        on: "2026-11-03",
        reviewOn: null,
      },
    });
    expect(refused.status).toBe(422);
    await keep(
      await as("quality", `/v1/workforce/cases/${caseId}/suspension`, {
        method: "PUT",
        body: {
          expectedVersion: detail.case.version,
          kind: "start",
          on: "2026-11-03",
          reviewOn: "2026-11-10",
        },
      }),
    );
    expect(detail.case.suspended).toBe(true);
  });

  it("refuses the investigator as hearing chair, and a hearing without the Acas steps", async () => {
    expect((await name(agencyId, "hearing_chair")).status).toBe(422);
    await keep(await name(DEMO.users.owner.id, "hearing_chair"));
    await keep(await move("quality", { to: "hearing", on: "2026-11-05" }));
    const noCompanion = await as("quality", `/v1/workforce/cases/${caseId}/hearings`, {
      method: "POST",
      body: {
        kind: "hearing",
        ledBy: DEMO.users.owner.id,
        invitedOn: "2026-11-05",
        scheduledAt: "2026-11-12T10:00:00Z",
        issueSetOut: true,
        evidenceShared: true,
        companionRightGiven: false,
      },
    });
    expect(noCompanion.status).toBe(422);
    await keep(
      await as("quality", `/v1/workforce/cases/${caseId}/hearings`, {
        method: "POST",
        body: {
          kind: "hearing",
          ledBy: DEMO.users.owner.id,
          invitedOn: "2026-11-05",
          scheduledAt: "2026-11-12T10:00:00Z",
          issueSetOut: true,
          evidenceShared: true,
          companionRightGiven: true,
        },
      }),
    );
  });

  it("decides only after the hearing is held, by the hearing chair", async () => {
    const early = await move("owner", {
      to: "outcome",
      on: "2026-11-12",
      outcome: "dismissal",
      appealRightGiven: true,
    });
    expect(early.status).toBe(422);
    const hearing = detail.hearings[0];
    await keep(
      await as("owner", `/v1/workforce/cases/${caseId}/hearings/${hearing?.id}`, {
        method: "PATCH",
        body: {
          expectedVersion: hearing?.version,
          state: "held",
          heldOn: "2026-11-12",
          accompanied: true,
        },
      }),
    );
    const byCaseManager = await move("quality", {
      to: "outcome",
      on: "2026-11-12",
      outcome: "dismissal",
      appealRightGiven: true,
    });
    expect(byCaseManager.status).toBe(403);
    // H-802: the removal flag goes only with an action short of dismissal.
    const flagged = await move("owner", {
      to: "outcome",
      on: "2026-11-12",
      outcome: "dismissal",
      appealRightGiven: true,
      removesFromRegulatedActivity: true,
    });
    expect(flagged.status).toBe(422);
    await keep(
      await move("owner", {
        to: "outcome",
        on: "2026-11-12",
        outcome: "dismissal",
        appealRightGiven: true,
      }),
    );
    expect(detail.case.outcome).toBe("dismissal");
    expect(detail.referrals.dbs.due).toBe(true);
  });

  it("hears the appeal by someone not involved, and closes only with the DBS decision and the suspension ended", async () => {
    await keep(
      await move("quality", {
        to: "appeal",
        on: "2026-11-15",
        grounds: "The sanction was too severe.",
      }),
    );
    expect(detail.timeline.some((e) => e.kind === "appeal_grounds")).toBe(true);
    // The Registered Manager reads nothing until named.
    expect((await as("manager", `/v1/workforce/cases/${caseId}`)).status).toBe(404);
    expect((await name(agencyId, "appeal_chair")).status).toBe(422);
    expect((await name(DEMO.users.owner.id, "appeal_chair")).status).toBe(422);
    await keep(await name(DEMO.users.manager.id, "appeal_chair"));
    expect((await as("manager", `/v1/workforce/cases/${caseId}`)).status).toBe(200);
    await keep(
      await as("quality", `/v1/workforce/cases/${caseId}/hearings`, {
        method: "POST",
        body: {
          kind: "appeal_hearing",
          ledBy: DEMO.users.manager.id,
          invitedOn: "2026-11-15",
          scheduledAt: "2026-11-22T10:00:00Z",
          issueSetOut: true,
          evidenceShared: true,
          companionRightGiven: true,
        },
      }),
    );
    const appealHearing = detail.hearings.find((x) => x.state === "scheduled");
    await keep(
      await as("manager", `/v1/workforce/cases/${caseId}/hearings/${appealHearing?.id}`, {
        method: "PATCH",
        body: {
          expectedVersion: appealHearing?.version,
          state: "held",
          heldOn: "2026-11-22",
          accompanied: false,
        },
      }),
    );
    const close = {
      to: "closed",
      on: "2026-11-22",
      reason: "appeal_decided",
      appealOutcome: "not_upheld",
    };
    expect((await move("manager", close)).status).toBe(422); // The suspension is still in force.
    await keep(
      await as("quality", `/v1/workforce/cases/${caseId}/suspension`, {
        method: "PUT",
        body: { expectedVersion: detail.case.version, kind: "end", on: "2026-11-22" },
      }),
    );
    expect((await move("manager", close)).status).toBe(422); // The DBS decision is missing.
    await keep(
      await as("quality", `/v1/workforce/cases/${caseId}/referrals`, {
        method: "PUT",
        body: {
          expectedVersion: detail.case.version,
          body: "dbs",
          decision: "referred",
          referredOn: "2026-11-22",
        },
      }),
    );
    const stale = await as("manager", `/v1/workforce/cases/${caseId}/move`, {
      method: "POST",
      body: { ...close, expectedVersion: detail.case.version - 1 },
    });
    expect(stale.status).toBe(409);
    await keep(await move("manager", close));
    expect(detail.case).toMatchObject({
      stage: "closed",
      closedReason: "appeal_decided",
      appealOutcome: "not_upheld",
    });
    // H-806: a dismissal referred to the DBS stays with the staff file.
    expect(detail.case.retentionClass).toBe("staff_file");
    const late = await as("agency", `/v1/workforce/cases/${caseId}/notes`, {
      method: "POST",
      body: { body: "A later note", occurredOn: "2026-11-23" },
    });
    expect(late.status).toBe(422);
  });

  it("removes a member, who then reads nothing", async () => {
    // A second case: the owner is named, then removed.
    await keep(
      await as("quality", "/v1/workforce/cases", {
        method: "POST",
        body: {
          caseType: "grievance",
          subjectTenantUserId: DEMO.users.carer.id,
          summary: SUMMARY,
          openedOn: "2026-11-24",
        },
      }),
      201,
    );
    caseId = detail.case.id;
    await keep(await name(DEMO.users.owner.id, "hr_adviser"));
    const owner = detail.members.find((m) => m.tenantUserId === DEMO.users.owner.id);
    expect((await as("owner", `/v1/workforce/cases/${caseId}`)).status).toBe(200);
    await keep(
      await as("quality", `/v1/workforce/cases/${caseId}/members/${owner?.id}/remove`, {
        method: "POST",
        body: { expectedVersion: owner?.version },
      }),
    );
    expect((await as("owner", `/v1/workforce/cases/${caseId}`)).status).toBe(404);
    const manager = detail.members.find((m) => m.role === "case_manager");
    const last = await as(
      "quality",
      `/v1/workforce/cases/${caseId}/members/${manager?.id}/remove`,
      {
        method: "POST",
        body: { expectedVersion: manager?.version },
      },
    );
    expect(last.status).toBe(422);
  });
});

describe("H-805 a case goes with the provider, never in the organisation-wide export", () => {
  it("is exported by its case manager, and by no other member", async () => {
    const exported = await as("quality", `/v1/workforce/cases/${caseId}/export`);
    expect(exported.status, await exported.clone().text()).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const body = await json<{ format: string; detail: { case: { id: string } } }>(exported);
    expect(body.format).toBe("harbour.employee_case.v1");
    expect(body.detail.case.id).toBe(caseId);
    // A member who is not a case manager is refused: the manager, named investigator on a new case.
    const fresh = await as("quality", "/v1/workforce/cases", {
      method: "POST",
      body: {
        caseType: "capability",
        subjectTenantUserId: DEMO.users.carer.id,
        summary: SUMMARY,
        openedOn: "2026-11-02",
      },
    });
    expect(fresh.status, await fresh.clone().text()).toBe(201);
    const freshId = (await json<Detail>(fresh)).case.id;
    const named = await as("quality", `/v1/workforce/cases/${freshId}/members`, {
      method: "POST",
      body: {
        tenantUserId: DEMO.users.manager.id,
        role: "investigator",
        independenceException: null,
      },
    });
    expect(named.status, await named.clone().text()).toBe(200);
    expect((await as("manager", `/v1/workforce/cases/${freshId}/export`)).status).toBe(403);
    expect([403, 404]).toContain(
      (await as("carer", `/v1/workforce/cases/${caseId}/export`)).status,
    );
  });

  it("raises a task for the case manager when the member of staff asks for their data", async () => {
    // The data protection lead runs the request: the quality lead holds quality.dsar.manage.
    const raised = await withRequestContext(
      createDatabase(h.db.pool("harbour_app")),
      { tenantId: DEMO.tenantId, userId: DEMO.users.owner.id, scope: "tenant", locationIds: [] },
      (tx) =>
        raiseCaseworkDsarTasks(tx, {
          requesterId: DEMO.users.carer.id,
          dsarReference: "DSAR-0001",
          dueOn: "2026-12-31",
        }),
    );
    expect(raised.tasks).toBeGreaterThan(0);
    const tasks = await sql<{ assignee_tenant_user_id: string; details: unknown }>(
      `SELECT assignee_tenant_user_id, details FROM task
        WHERE kind = 'workforce.casework_dsar_collection'`,
    );
    expect(tasks.map((t) => t.assignee_tenant_user_id)).toContain(QUALITY);
    expect(JSON.stringify(tasks)).not.toContain(SUMMARY);
  });
});

describe("colleagues to choose from (slice 58)", () => {
  it("lists members of staff by name for the caseworker, never to a care worker", async () => {
    const listed = await as("quality", "/v1/workforce/colleagues");
    expect(listed.status).toBe(200);
    const items = (await json<{ items: { id: string; displayName: string }[] }>(listed)).items;
    expect(items.map((i) => i.id)).toContain(DEMO.users.nurse.id);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["displayName", "id", "jobTitle"]);
    expect((await as("carer", "/v1/workforce/colleagues")).status).toBe(403);
  });

  it("never lists anyone who is not the provider's staff, nor a role not in force", async () => {
    // An inspector, someone whose role starts tomorrow, and someone whose only role is archived.
    const people = await sql<{ id: string; email: string }>(
      `INSERT INTO tenant_user (display_name, email, status) VALUES
         ('Ivy Example', 'inspector.s58@example.invalid', 'active'),
         ('Finn Example', 'future.s58@example.invalid', 'active'),
         ('Arlo Example', 'archived.s58@example.invalid', 'active')
       RETURNING id, email`,
    );
    const by = (prefix: string) => people.find((p) => p.email.startsWith(prefix))?.id ?? "";
    await sql(
      `INSERT INTO role (key, name, permissions, scope_kind, archived_at)
       VALUES ('s58_archived', 'Archived role', ARRAY['workforce.training.manage'], 'none', now())`,
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id, valid_from)
       SELECT $1::uuid, id, now() FROM role WHERE key = 'inspector'
       UNION ALL SELECT $2::uuid, id, now() + interval '1 day' FROM role WHERE key = 'care_worker'
       UNION ALL SELECT $3::uuid, id, now() FROM role WHERE key = 's58_archived'`,
      [by("inspector"), by("future"), by("archived")],
    );
    const items = (
      await json<{ items: { id: string }[] }>(await as("quality", "/v1/workforce/colleagues"))
    ).items.map((i) => i.id);
    for (const id of people.map((p) => p.id)) expect(items).not.toContain(id);
    // Nor can a request name them on a case past the picker.
    expect((await name(by("inspector"), "note_taker")).status).toBe(422);
    // The read is audited, with no names.
    const events = await sql<{ scope: unknown }>(
      `SELECT scope FROM audit_event WHERE action = 'workforce.colleague.listed'`,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("Example");
  });

  it("tells a non-member nothing about a case, its subject or its people", async () => {
    // The member of staff it is about is never a member of it.
    const response = await as("carer", `/v1/workforce/cases/${caseId}`);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(DEMO.users.carer.name);
    const list = await json<{ items: { id: string }[] }>(await as("carer", "/v1/workforce/cases"));
    expect(list.items.map((i) => i.id)).not.toContain(caseId);
  });

  it("names the case's people on the case", async () => {
    const seen = await json<{ staff: { id: string }[]; case: { subjectName: string | null } }>(
      await as("quality", `/v1/workforce/cases/${caseId}`),
    );
    expect(seen.case.subjectName).toBe(DEMO.users.carer.name);
    expect(seen.staff.map((s) => s.id)).toContain(DEMO.users.carer.id);
  });
});

describe("audit (ids and codes only)", () => {
  it("records every action against the case id, never the summary, grounds or names", async () => {
    const events = await sql<{ action: string; resource_id: string | null; scope: unknown }>(
      `SELECT action, resource_id, scope FROM audit_event WHERE action LIKE 'workforce.case.%'`,
    );
    const actions = new Set(events.map((e) => e.action));
    for (const action of [
      "workforce.case.opened",
      "workforce.case.viewed",
      "workforce.case.member_named",
      "workforce.case.moved",
      "workforce.case.hearing_arranged",
      "workforce.case.hearing_updated",
      "workforce.case.suspension",
      "workforce.case.referral_recorded",
    ]) {
      expect(actions, action).toContain(action);
    }
    const text = JSON.stringify(events);
    for (const secret of [SUMMARY, "too severe", DEMO.users.carer.id, "Carer"]) {
      expect(text).not.toContain(secret);
    }
    const refusals = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'workforce.case.%' AND outcome = 'denied'`,
    );
    expect(refusals[0]?.n).toBeGreaterThanOrEqual(5);
  });
});

describe("H-804 Thapsus support appoints a case manager on an approved ticket", () => {
  it("appoints the member the ticket names to a case whose case managers have all left", async () => {
    // A second case, then its only case manager leaves the organisation.
    const opened = await as("quality", "/v1/workforce/cases", {
      method: "POST",
      body: {
        caseType: "grievance",
        subjectTenantUserId: DEMO.users.carer.id,
        summary: SUMMARY,
        openedOn: "2026-11-02",
      },
    });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const orphan = (await json<Detail>(opened)).case.id;
    await sql("UPDATE tenant_user SET status = 'left' WHERE id = $1", [QUALITY]);
    // The Registered Manager is the organisation's data protection lead.
    await sql(
      `INSERT INTO role (key, name, permissions, scope_kind)
       VALUES ('s804_dpl', 'Data protection lead', ARRAY['platform.dpia.sign'], 'tenant')`,
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       SELECT $1::uuid, id FROM role WHERE key = 's804_dpl'`,
      [DEMO.users.manager.id],
    );

    const raised = await as("owner", "/v1/workforce/casework-support-tickets", {
      method: "POST",
      body: {
        caseId: orphan,
        newManagerId: DEMO.users.nurse.id,
        reason: "The case manager has left the organisation",
      },
    });
    expect(raised.status, await raised.clone().text()).toBe(201);
    const ticket = await json<{ id: string; version: number }>(raised);
    const appoint = () =>
      h.request(
        `/operator/tenants/${DEMO.tenantId}/casework-support-tickets/${ticket.id}/appoint`,
        {
          method: "POST",
          token: h.tokens.opsAdmin,
        },
      );
    // Not before the data protection lead approves it, and never by the requester.
    expect((await appoint()).status).toBe(409);
    expect(
      (
        await as("owner", `/v1/workforce/casework-support-tickets/${ticket.id}/approve`, {
          method: "POST",
          body: { expectedVersion: ticket.version },
        })
      ).status,
    ).toBe(403);
    const approved = await as(
      "manager",
      `/v1/workforce/casework-support-tickets/${ticket.id}/approve`,
      {
        method: "POST",
        body: { expectedVersion: ticket.version },
      },
    );
    expect(approved.status, await approved.clone().text()).toBe(200);

    expect((await appoint()).status).toBe(200);
    expect((await appoint()).status).toBe(409);
    const [member] = await sql<{ member_role: string }>(
      "SELECT member_role FROM employee_case_member WHERE case_id = $1 AND tenant_user_id = $2",
      [orphan, DEMO.users.nurse.id],
    );
    expect(member?.member_role).toBe("case_manager");
    // Shown to the organisation, by ids only.
    const [shown] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE action = 'workforce.case.manager_appointed_by_support' AND resource_id = $1`,
      [ticket.id],
    );
    expect(shown?.n).toBe(1);
  });
});
