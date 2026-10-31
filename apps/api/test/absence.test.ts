import { DEMO } from "@harbour/db/seed";
import { ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Absence and leave through the API (scheduling.md section 17; SCHED-010; hazards HZ-123 and
 * HZ-124): a member asks for leave and an approver (never the member) decides; approving raises a
 * cover need on the member's rostered shift, the rota shows it and the check counts it as open;
 * nobody is put on a shift on a day they are away; cancelling and taking them off resolve it; a
 * sickness with a fit note (health data, HR only), return to work, the Bradford factor with its
 * working and the SSP working for payroll. Audit events carry no reasons or notes. Invented people.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const post = (who: string, path: string, body: unknown) => as(who, path, { method: "POST", body });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

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

const LOC = DEMO.locationId;
const CARER = DEMO.users.carer.id;
const today = () => ukIsoDate(new Date());
const inDays = (n: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

type Absence = { id: string; version: number; state: string; coverNeeded: number };
let rotaId = "";
let shiftId = "";
let assignmentId = "";
let secondShift = "";

beforeAll(async () => {
  h = await createHarness();
  // A draft rota at the demo home with the carer on a shift in a fortnight, and an open shift.
  const [rota] = await sql<{ id: string }>(
    "INSERT INTO rota (location_id, starts_on, ends_on) VALUES ($1, $2, $3) RETURNING id",
    [LOC, inDays(14), inDays(20)],
  );
  rotaId = rota?.id as string;
  const [s] = await sql<{ id: string }>(
    `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at, break_minutes)
     VALUES ($1, $2, 'Early', 'work', $3::date + time '07:00', $3::date + time '15:00', 30) RETURNING id`,
    [rotaId, LOC, inDays(15)],
  );
  shiftId = s?.id as string;
  const [a] = await sql<{ id: string }>(
    "INSERT INTO shift_assignment (shift_id, location_id, worker_id) VALUES ($1, $2, $3) RETURNING id",
    [shiftId, LOC, CARER],
  );
  assignmentId = a?.id as string;
  const [s2] = await sql<{ id: string }>(
    `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at, break_minutes)
     VALUES ($1, $2, 'Late', 'work', $3::date + time '14:00', $3::date + time '22:00', 30) RETURNING id`,
    [rotaId, LOC, inDays(16)],
  );
  secondShift = s2?.id as string;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("SCHED-010 requests and decisions", () => {
  let leave: Absence;

  it("a member asks for their own leave; a sickness is never asked for", async () => {
    const r = await post("carer", "/v1/absences", {
      locationId: LOC,
      kind: "annual_leave",
      startsOn: inDays(15),
      endsOn: inDays(17),
    });
    expect(r.status).toBe(201);
    leave = (await r.json()) as Absence;
    expect(leave.state).toBe("requested");
    const sick = await post("carer", "/v1/absences", {
      locationId: LOC,
      kind: "sickness",
      startsOn: today(),
      endsOn: null,
    });
    expect(sick.status).toBe(422);
    expect(await codeOf(sick)).toBe("absence_sickness_not_requested");
    // A care worker records nothing for anyone else.
    const other = await post("carer", "/v1/absences", {
      memberId: DEMO.users.nurse.id,
      locationId: LOC,
      kind: "annual_leave",
      startsOn: inDays(15),
      endsOn: inDays(17),
    });
    expect(other.status).toBe(403);
  });

  it("hazard HZ-123 the member cannot approve their own; the manager can, raising a cover need", async () => {
    const mine = await post("manager", "/v1/absences", {
      locationId: LOC,
      kind: "annual_leave",
      startsOn: inDays(40),
      endsOn: inDays(41),
    });
    const own = (await mine.json()) as Absence;
    const self = await post("manager", `/v1/absences/${own.id}/decision`, {
      version: own.version,
      decision: "approve",
    });
    expect(self.status).toBe(422);
    expect(await codeOf(self)).toBe("absence_decider_is_member");
    const decline = await post("manager", `/v1/absences/${leave.id}/decision`, {
      version: leave.version,
      decision: "decline",
    });
    expect(decline.status).toBe(422);
    expect(await codeOf(decline)).toBe("absence_reason_required");
    const ok = await post("manager", `/v1/absences/${leave.id}/decision`, {
      version: leave.version,
      decision: "approve",
    });
    expect(ok.status).toBe(200);
    leave = (await ok.json()) as Absence;
    expect(leave.state).toBe("approved");
    expect(leave.coverNeeded).toBe(1);
  });

  it("hazard HZ-123 the rota keeps the carer on the shift, flagged, and the check counts it as open", async () => {
    const rota = (await (await as("manager", `/v1/rotas/${rotaId}`)).json()) as {
      shifts: { id: string; assignment: { worker: { id: string }; coverNeeded: boolean } | null }[];
    };
    const flagged = rota.shifts.find((s) => s.id === shiftId);
    expect(flagged?.assignment?.worker.id).toBe(CARER);
    expect(flagged?.assignment?.coverNeeded).toBe(true);
    const check = (await (await as("manager", `/v1/rotas/${rotaId}/check`)).json()) as {
      coverNeededAssignmentIds: string[];
      hasWarnings: boolean;
      staffing: { date: string; warnings: string[] }[];
    };
    expect(check.coverNeededAssignmentIds).toEqual([assignmentId]);
    expect(check.hasWarnings).toBe(true);
  });

  it("hazard HZ-124 nobody is put on a shift on a day they are away", async () => {
    const [s] = await sql<{ version: number }>("SELECT version FROM shift WHERE id = $1", [
      secondShift,
    ]);
    const r = await post("manager", `/v1/shifts/${secondShift}/assignment`, {
      workerId: CARER,
      version: s?.version,
    });
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("member_absent");
  });

  it("hazard HZ-123 taking the member off resolves the cover need; cancelling resolves the rest", async () => {
    const [a] = await sql<{ version: number }>(
      "SELECT version FROM shift_assignment WHERE id = $1",
      [assignmentId],
    );
    const off = await post("manager", `/v1/shift-assignments/${assignmentId}/remove`, {
      version: a?.version,
      reason: "On approved leave",
    });
    expect(off.status).toBe(200);
    const [need] = await sql<{ resolution: string }>(
      "SELECT resolution FROM shift_cover_need WHERE assignment_id = $1",
      [assignmentId],
    );
    expect(need?.resolution).toBe("assignment_removed");
    // The member may not cancel approved leave; the manager can, with a reason.
    const mine = await post("carer", `/v1/absences/${leave.id}/cancel`, { version: leave.version });
    expect([403, 422]).toContain(mine.status);
    const cancel = await post("manager", `/v1/absences/${leave.id}/cancel`, {
      version: leave.version,
      reason: "Leave moved",
    });
    expect(cancel.status).toBe(200);
    const audit = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE resource_id = $1 AND action LIKE 'scheduling.absence.%'",
      [leave.id],
    );
    expect(JSON.stringify(audit)).not.toMatch(/Leave moved/);
  });

  it("another organisation's member's absence is not found", async () => {
    const r = await post("manager", "/v1/absences", {
      memberId: OTHER.managerId,
      locationId: LOC,
      kind: "sickness",
      startsOn: today(),
      endsOn: null,
    });
    expect(r.status).toBe(404);
  });
});

describe("hazard HZ-123 cover needs at another home and on a published rota", () => {
  it("raises a need on the member's shift at another home and marks a published shift changed", async () => {
    // The carer also works a published shift at Harbour Lodge, whose rota the manager cannot see.
    const [rota] = await sql<{ id: string }>(
      "INSERT INTO rota (location_id, starts_on, ends_on, state, published_at) VALUES ($1, $2, $3, 'published', now()) RETURNING id",
      [LODGE.locationId, inDays(60), inDays(66)],
    );
    const [s] = await sql<{ id: string }>(
      `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at, break_minutes, published_at)
       VALUES ($1, $2, 'Night', 'work', $3::date + time '20:00', $3::date + time '20:00' + interval '12 hours', 30, now()) RETURNING id`,
      [rota?.id, LODGE.locationId, inDays(61)],
    );
    await sql(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) SELECT $1, id, $2 FROM role WHERE key = 'care_worker'",
      [CARER, LODGE.locationId],
    );
    const [a] = await sql<{ id: string }>(
      "INSERT INTO shift_assignment (shift_id, location_id, worker_id, published_at) VALUES ($1, $2, $3, now()) RETURNING id",
      [s?.id, LODGE.locationId, CARER],
    );
    // A sickness recorded at the demo home from the morning the night shift ends.
    const r = await post("manager", "/v1/absences", {
      memberId: CARER,
      locationId: LOC,
      kind: "sickness",
      startsOn: inDays(62),
      endsOn: inDays(63),
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as Absence).coverNeeded).toBe(1);
    const [need] = await sql<{ location_id: string }>(
      "SELECT location_id FROM shift_cover_need WHERE assignment_id = $1 AND resolved_at IS NULL",
      [a?.id],
    );
    expect(need?.location_id).toBe(LODGE.locationId);
    const [changed] = await sql<{ changed_after_publish_at: Date | null }>(
      "SELECT changed_after_publish_at FROM shift WHERE id = $1",
      [s?.id],
    );
    expect(changed?.changed_after_publish_at).not.toBeNull();
    const [event] = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'scheduling.cover_needed' AND aggregate_id = $1",
      [s?.id],
    );
    expect(event?.n).toBe(1);
  });
});

describe("SCHED-010 sickness, fit notes and return to work (health data)", () => {
  let sick: Absence;

  it("is recorded by a manager, self-certified, and needs a fit note after seven days", async () => {
    const r = await post("manager", "/v1/absences", {
      memberId: CARER,
      locationId: LOC,
      kind: "sickness",
      startsOn: inDays(-10),
      endsOn: null,
      selfCertified: true,
    });
    expect(r.status).toBe(201);
    sick = (await r.json()) as Absence & { fitNoteUncoveredDays: string[] | null };
    expect(sick.state).toBe("recorded");
    // Fit note coverage is HR's (workforce.hr_document.read): the owner sees it, the manager not.
    expect((sick as unknown as { fitNoteUncoveredDays: unknown }).fitNoteUncoveredDays).toBeNull();
    const hr = (await (await as("owner", `/v1/absences/${sick.id}`)).json()) as {
      fitNoteUncoveredDays: string[];
    };
    // Eleven days so far: the four after the seven self-certified days need a fit note.
    expect(hr.fitNoteUncoveredDays).toHaveLength(4);
    // The care worker sees their own absence but no fit note coverage.
    const own = (await (await as("carer", `/v1/absences/${sick.id}`)).json()) as {
      fitNoteUncoveredDays: string[] | null;
    };
    expect(own.fitNoteUncoveredDays).toBeNull();
  });

  it("a fit note is stored as an HR-only document, never with the condition, and opened audited", async () => {
    const q = new URLSearchParams({
      issuedOn: inDays(-3),
      coversFrom: inDays(-3),
      coversTo: inDays(10),
      fitness: "not_fit",
    });
    const carer = await h.request(`/v1/absences/${sick.id}/fit-notes?${q}`, {
      method: "POST",
      raw: { bytes: PDF, contentType: "application/pdf" },
      token: h.tokens.carer,
      tenant: DEMO.tenantId,
    });
    expect(carer.status).toBe(403);
    const r = await h.request(`/v1/absences/${sick.id}/fit-notes?${q}`, {
      method: "POST",
      raw: { bytes: PDF, contentType: "application/pdf" },
      token: h.tokens.owner,
      tenant: DEMO.tenantId,
    });
    expect(r.status).toBe(201);
    const note = (await r.json()) as { id: string; documentId: string };
    // The manager without HR documents sees no fit notes on the absence.
    const plain = (await (await as("manager", `/v1/absences/${sick.id}`)).json()) as {
      fitNotes: unknown;
    };
    expect(plain.fitNotes).toBeNull();
    const [doc] = await sql<{ category: string; retention_class: string }>(
      "SELECT category, retention_class FROM document WHERE id = $1",
      [note.documentId],
    );
    expect(doc).toEqual({ category: "staff_hr_document", retention_class: "sickness_absence" });
    const detail = (await (await as("owner", `/v1/absences/${sick.id}`)).json()) as {
      fitNoteUncoveredDays: string[];
      fitNotes: unknown[];
    };
    // The note covers every day after the self-certified ones.
    expect(detail.fitNoteUncoveredDays).toEqual([]);
    expect(detail.fitNotes).toHaveLength(1);
    const open = await as("owner", `/v1/absences/${sick.id}/fit-notes/${note.id}/content`);
    expect(open.status).toBe(200);
    const [viewed] = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_event WHERE action = 'workforce.fit_note.viewed' AND resource_id = $1",
      [sick.id],
    );
    expect(viewed?.n).toBe(1);
  });

  it("is ended, then a return to work is recorded once, by someone other than the member", async () => {
    const current = (await (await as("manager", `/v1/absences/${sick.id}`)).json()) as Absence;
    const end = await post("manager", `/v1/absences/${sick.id}/end`, {
      version: current.version,
      endsOn: inDays(-1),
    });
    expect(end.status).toBe(200);
    const body = { version: 1, heldOn: today(), fitForUsualDuties: true, notes: "Feeling better." };
    const r = await post("owner", `/v1/absences/${sick.id}/return-to-work`, body);
    expect(r.status).toBe(201);
    const again = await post("owner", `/v1/absences/${sick.id}/return-to-work`, body);
    expect(again.status).toBe(409);
    const audit = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE resource_id = $1",
      [sick.id],
    );
    expect(JSON.stringify(audit)).not.toMatch(/Feeling better/);
  });

  it("the Bradford factor comes with its working and a notice, never a judgement (H-583)", async () => {
    // Leaving a sickness out is HR's at the home, never a rota manager's.
    const current = (await (await as("owner", `/v1/absences/${sick.id}`)).json()) as Absence;
    const byManager = await post("manager", `/v1/absences/${sick.id}/bradford-exclusion`, {
      version: current.version,
      reason: "Disability related",
    });
    expect(byManager.status).toBe(403);
    const r = await as("owner", `/v1/members/${CARER}/bradford`);
    expect(r.status).toBe(200);
    const out = (await r.json()) as {
      spells: number;
      days: number;
      score: number;
      windowWeeks: number;
      working: string[];
      notice: string;
    };
    expect(out.spells).toBe(1);
    expect(out.days).toBe(10);
    expect(out.score).toBe(10);
    expect(out.windowWeeks).toBe(52);
    expect(out.working.join(" ")).toMatch(/absence\.bradford\.window_weeks/);
    expect(out.notice).toMatch(/never compares it with a trigger/);
    expect((await as("carer", `/v1/members/${CARER}/bradford`)).status).toBe(403);
  });

  it("the SSP working uses the period of incapacity and the slice 6 rule", async () => {
    const r = await post("owner", `/v1/absences/${sick.id}/ssp`, {
      averageWeeklyEarningsPence: 40000,
      qualifyingWeekdays: [1, 2, 3, 4, 5],
    });
    expect(r.status).toBe(200);
    const out = (await r.json()) as {
      applies: boolean;
      periodOfIncapacity: { linkedAbsences: number } | null;
      weeklyPence: number;
      daysPaid: number;
      inputHash: string;
      notice: string;
    };
    expect(out.applies).toBe(true);
    expect(out.periodOfIncapacity?.linkedAbsences).toBe(1);
    // The lower of 80% of £400.00 (£320.00) and the weekly rate.
    expect(out.weeklyPence).toBeLessThanOrEqual(32_000);
    expect(out.daysPaid).toBeGreaterThan(0);
    expect(out.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const audit = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'scheduling.ssp.calculated' AND resource_id = $1",
      [sick.id],
    );
    expect(JSON.stringify(audit)).not.toMatch(/40000/);
  });
});
