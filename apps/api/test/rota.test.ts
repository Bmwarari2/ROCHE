import { DEMO } from "@harbour/db/seed";
import { DEPENDENCY_TOOL_NOTICE, STAFFING_STATUS_WORDS, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The rota builder through the API (scheduling.md section 14; SCHED-001, SCHED-002; hazards
 * HZ-123 and HZ-124): templates, patterns and shifts; assigning with the rostering rule from the
 * staff file and the competence port, a manager's justified override (never for a right to work,
 * never for oneself); working time as advice; the pre-publish check with the staffing comparison
 * against the organisation's own scale, which publishing must have seen; notice recorded; a
 * member's own published shifts; another organisation's rota not found; audit with ids only.
 */

let h: Harness;
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

const today = () => ukIsoDate(new Date());
const inDays = (n: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const LOC = DEMO.locationId;
const CARER = DEMO.users.carer.id;
const NURSE = DEMO.users.nurse.id;
const MANAGER = DEMO.users.manager.id;
const OWNER = DEMO.users.owner.id;

interface Shift {
  id: string;
  version: number;
  date: string;
  startsAt: string;
  label: string;
  publishedAt: string | null;
  changedAfterPublishAt: string | null;
  assignment: { id: string; version: number; worker: { id: string }; overridden: string[] } | null;
}
interface Rota {
  id: string;
  changedSincePublished: boolean;
  version: number;
  state: string;
  shifts: Shift[];
  publications: { noticeMinutes: number | null; shiftCount: number; openShiftCount: number }[];
}
interface Check {
  digest: string;
  periodsToAcknowledge: string[];
  rotaVersion: number;
  hasWarnings: boolean;
  blockedAssignmentIds: string[];
  openShiftIds: string[];
  staffing: {
    date: string;
    periodKey: string | null;
    status: string;
    word: string;
    notice: string;
    method: string[];
    warnings: string[];
    providedMinutes: number;
  }[];
  workingTime: { workerId: string; status: string; notes: string[] }[];
  eligibility: {
    assignmentId: string;
    allowed: boolean;
    covered: boolean;
    blockers: { key: string }[];
  }[];
}

/** A staff file with a verified DBS and right to work (invented details). */
async function staffFile(worker: string, opts: { dateOfBirth?: string | null } = {}) {
  const [profile] = await sql<{ id: string }>(
    `INSERT INTO staff_profile (tenant_user_id, location_id, job_title, date_of_birth, starts_on)
     VALUES ($1, $2, 'Care worker', $3, '2025-01-06') RETURNING id`,
    [worker, LOC, opts.dateOfBirth === undefined ? "1990-05-01" : opts.dateOfBirth],
  );
  const id = profile?.id;
  await sql(
    `INSERT INTO compliance_item (staff_profile_id, kind, detail, verified_on, verified_by) VALUES
       ($1, 'dbs_certificate', $2, '2025-01-02', $4),
       ($1, 'right_to_work', $3, '2025-01-02', $4)`,
    [
      id,
      JSON.stringify({
        kind: "dbs_certificate",
        certificate: {
          level: "enhanced_adults_barred",
          issuedOn: "2025-01-01",
          number: "009999999999",
          result: "clear",
        },
        updateService: null,
        barredListClearOn: null,
      }),
      JSON.stringify({
        kind: "right_to_work",
        checks: [
          {
            checkedOn: "2025-01-02",
            permission: "unlimited",
            expiresOn: null,
            method: "online_share_code",
          },
        ],
      }),
      worker === OWNER ? MANAGER : OWNER,
    ],
  );
  return id as string;
}

const getRota = async (id: string) =>
  (await (await as("manager", `/v1/rotas/${id}`)).json()) as Rota;
const check = async (id: string, who = "manager") => {
  const response = await as(who, `/v1/rotas/${id}/check`);
  expect(response.status).toBe(200);
  return (await response.json()) as Check;
};

let dayTemplate: string;
let medsTemplate: string;
let rotaId: string;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("shift templates and patterns", () => {
  it("lets a manager make a template and refuses a care worker", async () => {
    const body = { name: "Day", kind: "work", startMinute: 480, endMinute: 1200, breakMinutes: 30 };
    const refused = await as("carer", `/v1/locations/${LOC}/shift-templates`, {
      method: "POST",
      body,
    });
    expect([403, 404]).toContain(refused.status);
    const made = await as("manager", `/v1/locations/${LOC}/shift-templates`, {
      method: "POST",
      body,
    });
    expect(made.status).toBe(201);
    dayTemplate = ((await made.json()) as { id: string }).id;
    const meds = await as("manager", `/v1/locations/${LOC}/shift-templates`, {
      method: "POST",
      body: {
        ...body,
        name: "Medicines round",
        startMinute: 420,
        endMinute: 900,
        requiredCompetences: ["medicines_administration"],
        requiredSkills: ["medicines_competent"],
      },
    });
    expect(meds.status).toBe(201);
    medsTemplate = ((await meds.json()) as { id: string }).id;
  });

  it("refuses a break as long as the shift", async () => {
    const response = await as("manager", `/v1/locations/${LOC}/shift-templates`, {
      method: "POST",
      body: { name: "Odd", kind: "work", startMinute: 480, endMinute: 540, breakMinutes: 60 },
    });
    expect(response.status).toBe(422);
  });

  it("refuses a pattern with an unknown template", async () => {
    const response = await as("manager", `/v1/locations/${LOC}/shift-patterns`, {
      method: "POST",
      body: {
        name: "Week",
        cycleDays: 7,
        entries: [{ day: 0, templateId: OTHER.locationId, count: 1 }],
      },
    });
    expect(response.status).toBe(422);
  });
});

describe("rotas and shifts", () => {
  it("starts a rota and refuses one that overlaps or is too long", async () => {
    const made = await as("manager", `/v1/locations/${LOC}/rotas`, {
      method: "POST",
      body: { startsOn: inDays(14), endsOn: inDays(15) },
    });
    expect(made.status).toBe(201);
    rotaId = ((await made.json()) as Rota).id;
    const overlap = await as("manager", `/v1/locations/${LOC}/rotas`, {
      method: "POST",
      body: { startsOn: inDays(15), endsOn: inDays(20) },
    });
    expect(overlap.status).toBe(409);
    const long = await as("manager", `/v1/locations/${LOC}/rotas`, {
      method: "POST",
      body: { startsOn: inDays(30), endsOn: inDays(80) },
    });
    expect(long.status).toBe(422);
  });

  it("applies a pattern as open shifts at UK wall-clock times", async () => {
    const pattern = await as("manager", `/v1/locations/${LOC}/shift-patterns`, {
      method: "POST",
      body: {
        name: "Every day",
        cycleDays: 1,
        entries: [{ day: 0, templateId: dayTemplate, count: 2 }],
      },
    });
    expect(pattern.status).toBe(201);
    const patternId = ((await pattern.json()) as { id: string }).id;
    const rota = await getRota(rotaId);
    const applied = await as("manager", `/v1/rotas/${rotaId}/apply-pattern`, {
      method: "POST",
      body: { patternId, version: rota.version },
    });
    expect(applied.status).toBe(200);
    const after = (await applied.json()) as Rota;
    expect(after.shifts).toHaveLength(4);
    expect(after.shifts.every((s) => s.assignment === null)).toBe(true);
    const first = after.shifts[0] as Shift;
    expect(first.date).toBe(inDays(14));
    // 08:00 UK time, whichever offset is in force.
    expect(
      new Date(first.startsAt).toLocaleTimeString("en-GB", { timeZone: "Europe/London" }),
    ).toBe("08:00:00");
  });

  it("adds a shift from a template", async () => {
    const response = await as("manager", `/v1/rotas/${rotaId}/shifts`, {
      method: "POST",
      body: { date: inDays(15), templateId: medsTemplate },
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as Rota).shifts).toHaveLength(5);
  });

  it("does not show another organisation a rota", async () => {
    const response = await h.request(`/v1/rotas/${rotaId}`, {
      token: h.tokens.agency,
      tenant: OTHER.tenantId,
    });
    expect([403, 404]).toContain(response.status);
  });
});

describe("hazard HZ-124 assigning applies the rostering rule", () => {
  it("hazard HZ-124 blocks a member with no staff file, and never overrides the right to work", async () => {
    const shift = (await getRota(rotaId)).shifts[0] as Shift;
    const eligibility = await as("manager", `/v1/shifts/${shift.id}/eligibility?workerId=${CARER}`);
    expect(eligibility.status).toBe(200);
    const answer = (await eligibility.json()) as {
      allowed: boolean;
      overridable: boolean;
      blockers: { key: string; message: string }[];
    };
    expect(answer.allowed).toBe(false);
    expect(answer.overridable).toBe(false);
    expect(answer.blockers.map((b) => b.key)).toContain("right_to_work:none");
    const overridden = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: {
        workerId: CARER,
        version: shift.version,
        override: {
          justification: "Covering sickness at short notice",
          blockerKeys: ["dbs:no_certificate"],
        },
      },
    });
    expect(overridden.status).toBe(422);
    expect(((await overridden.json()) as { code: string }).code).toBe("right_to_work");
  });

  it("hazard HZ-124 assigns a member whose checks are in order, with working time as advice", async () => {
    await staffFile(CARER);
    const shift = (await getRota(rotaId)).shifts[0] as Shift;
    const response = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: { workerId: CARER, version: shift.version },
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as {
      shift: Shift;
      eligibility: { allowed: boolean };
      workingTime: { status: string; notes: string[] };
    };
    expect(result.shift.assignment?.worker.id).toBe(CARER);
    expect(result.workingTime.status).toBe("checked");
    expect(result.workingTime.notes.join(" ")).toMatch(/advice/);
  });

  it("refuses the same member on two shifts at once", async () => {
    const shift = (await getRota(rotaId)).shifts[1] as Shift;
    const response = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: { workerId: CARER, version: shift.version },
    });
    expect(response.status).toBe(409);
  });

  it("hazard HZ-124 refuses a member without the competence the shift needs, unless overridden", async () => {
    const shift = (await getRota(rotaId)).shifts.find(
      (s) => s.label === "Medicines round",
    ) as Shift;
    const plain = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: { workerId: CARER, version: shift.version },
    });
    expect(plain.status).toBe(422);
    expect(((await plain.json()) as { code: string }).code).toBe("not_eligible");
    const tick = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: {
        workerId: CARER,
        version: shift.version,
        override: {
          justification: "ok",
          blockerKeys: ["competence:medicines_administration:missing"],
        },
      },
    });
    expect(tick.status).toBe(422);
    const shown = (await (
      await as("manager", `/v1/shifts/${shift.id}/eligibility?workerId=${CARER}`)
    ).json()) as { blockers: { key: string }[] };
    expect(shown.blockers.map((b) => b.key)).toEqual([
      "competence:medicines_administration:missing",
    ]);
    const wrong = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: {
        workerId: CARER,
        version: shift.version,
        override: {
          justification: "Nurse in charge gives medicines; carer assists only",
          blockerKeys: ["registration"],
        },
      },
    });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { code: string }).code).toBe("blockers_changed");
    const overridden = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: {
        workerId: CARER,
        version: shift.version,
        override: {
          justification: "Nurse in charge gives medicines; carer assists only",
          blockerKeys: shown.blockers.map((b) => b.key),
        },
      },
    });
    expect(overridden.status).toBe(201);
    const result = (await overridden.json()) as { shift: Shift };
    expect(result.shift.assignment?.overridden).toEqual([
      "competence:medicines_administration:missing",
    ]);
    const rows = await sql<{ justification: string; created_by: string }>(
      "SELECT justification, created_by FROM roster_override",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_by).toBe(MANAGER);
    const audit = await sql<{ detail: string }>(
      "SELECT row_to_json(a)::text AS detail FROM audit_event a WHERE action = 'scheduling.roster_override.given' AND reason IS NULL",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).not.toContain("Nurse in charge");
  });

  it("hazard HZ-124 refuses an override from a member without scheduling.rota.approve", async () => {
    const shift = (await getRota(rotaId)).shifts[1] as Shift;
    const response = await as("carer", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: {
        workerId: NURSE,
        version: shift.version,
        override: {
          justification: "Covering sickness at short notice",
          blockerKeys: ["registration"],
        },
      },
    });
    expect(response.status).toBe(403);
  });

  it("hazard HZ-124 refuses a manager overriding the rule for their own shift", async () => {
    const shift = (await getRota(rotaId)).shifts[1] as Shift;
    const response = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: {
        workerId: MANAGER,
        version: shift.version,
        override: {
          justification: "Covering sickness at short notice",
          blockerKeys: ["registration"],
        },
      },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("separation_of_duties");
  });

  it("hazard HZ-124 refuses a suspended member, and no override covers it", async () => {
    await sql("UPDATE tenant_user SET status = 'suspended' WHERE id = $1", [CARER]);
    try {
      const shift = (await getRota(rotaId)).shifts.find(
        (s) => s.label === "Day" && s.assignment === null,
      ) as Shift;
      const response = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
        method: "POST",
        body: {
          workerId: CARER,
          version: shift.version,
          override: {
            justification: "Covering sickness at short notice",
            blockerKeys: ["not_active"],
          },
        },
      });
      expect(response.status).toBe(422);
      expect(((await response.json()) as { code: string }).code).toBe("not_active");
    } finally {
      await sql("UPDATE tenant_user SET status = 'active' WHERE id = $1", [CARER]);
    }
  });

  it("does not answer for a member who does not work at the location", async () => {
    const [member] = await sql<{ id: string }>(
      `INSERT INTO tenant_user (display_name, email, status)
       VALUES ('Lou Lodge', 'lou.lodge@example.invalid', 'active') RETURNING id`,
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT $1, id, $2 FROM role WHERE key = 'care_worker' LIMIT 1`,
      [member?.id, LODGE.locationId],
    );
    const shift = (await getRota(rotaId)).shifts[0] as Shift;
    const response = await as(
      "manager",
      `/v1/shifts/${shift.id}/eligibility?workerId=${member?.id}`,
    );
    expect(response.status).toBe(404);
  });

  it("hazard HZ-124 checks a night shift on the date it ends too (a right to work expiring overnight)", async () => {
    const owner = await staffFile(OWNER);
    await sql(
      `UPDATE compliance_item SET detail = $2 WHERE staff_profile_id = $1 AND kind = 'right_to_work'`,
      [
        owner,
        JSON.stringify({
          kind: "right_to_work",
          checks: [
            {
              checkedOn: "2025-01-02",
              permission: "time_limited",
              expiresOn: inDays(14),
              method: "online_share_code",
            },
          ],
        }),
      ],
    );
    const added = await as("manager", `/v1/rotas/${rotaId}/shifts`, {
      method: "POST",
      body: {
        date: inDays(14),
        label: "Night",
        kind: "work",
        startMinute: 1200,
        endMinute: 480,
        breakMinutes: 30,
      },
    });
    expect(added.status).toBe(201);
    const night = ((await added.json()) as Rota).shifts.find((s) => s.label === "Night") as Shift;
    const answer = (await (
      await as("manager", `/v1/shifts/${night.id}/eligibility?workerId=${OWNER}`)
    ).json()) as { allowed: boolean; overridable: boolean; blockers: { key: string }[] };
    expect(answer.allowed).toBe(false);
    expect(answer.overridable).toBe(false);
    expect(answer.blockers.map((b) => b.key)).toEqual(["right_to_work:lapsed"]);
    const cancelled = await as("manager", `/v1/shifts/${night.id}/cancel`, {
      method: "POST",
      body: { version: night.version, reason: "Added for a test of the rule" },
    });
    expect(cancelled.status).toBe(200);
  });

  it("says when the working time check cannot run", async () => {
    await staffFile(NURSE, { dateOfBirth: null });
    const shift = (await getRota(rotaId)).shifts.find(
      (s) => s.label === "Day" && s.date === inDays(15) && s.assignment === null,
    ) as Shift;
    const response = await as("manager", `/v1/shifts/${shift.id}/assignment`, {
      method: "POST",
      body: { workerId: NURSE, version: shift.version },
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as { workingTime: { status: string } };
    expect(result.workingTime.status).toBe("cannot_check");
  });
});

describe("hazard HZ-123 the check before publishing", () => {
  it("is refused to a care worker", async () => {
    const response = await as("carer", `/v1/rotas/${rotaId}/check`);
    expect([403, 404]).toContain(response.status);
  });

  it("hazard HZ-123 gives no figure without a scale, never 0, with the status in words", async () => {
    const result = await check(rotaId);
    expect(result.staffing.length).toBeGreaterThan(0);
    for (const s of result.staffing) {
      expect(s.status).toBe("no_scale");
      expect(s.word).toBe(STAFFING_STATUS_WORDS.no_scale);
      expect(s.notice).toBe(DEPENDENCY_TOOL_NOTICE);
    }
    expect(result.hasWarnings).toBe(true);
  });

  it("hazard HZ-123 compares the rota with the organisation's scale per period, with the method", async () => {
    const definition = {
      periods: [
        { key: "day", label: "Day", startMinute: 480 },
        { key: "night", label: "Night", startMinute: 1200 },
      ],
      categories: [
        {
          key: "low",
          label: "Low",
          description: null,
          careMinutes: [
            { periodKey: "day", minutes: 60 },
            { periodKey: "night", minutes: 20 },
          ],
        },
      ],
      skillMix: [{ skill: "medicines_competent", periodKey: "day", minimumStaff: 1 }],
      reviewIntervalDays: null,
    };
    const made = await as("manager", "/v1/dependency-scales", {
      method: "POST",
      body: { name: "Rota scale", locationId: LOC, definition },
    });
    expect(made.status).toBe(201);
    const scale = (await made.json()) as { id: string; draft: { id: string; version: number } };
    const approved = await as(
      "owner",
      `/v1/dependency-scales/${scale.id}/versions/${scale.draft.id}/approve`,
      { method: "POST", body: { version: scale.draft.version } },
    );
    expect(approved.status).toBe(200);
    const result = await check(rotaId);
    const day = result.staffing.find((s) => s.date === inDays(14) && s.periodKey === "day");
    expect(day).toBeDefined();
    expect(day?.status).not.toBe("met");
    expect(day?.word.length).toBeGreaterThan(0);
    expect(day?.providedMinutes).toBeGreaterThan(0);
    expect(day?.method.join(" ")).toMatch(/Rota:/);
    expect(day?.warnings.length).toBeGreaterThan(0);
  });

  it("hazard HZ-124 shows each assignment's eligibility again and whether an override covers it", async () => {
    const result = await check(rotaId);
    expect(result.eligibility).toHaveLength(3);
    expect(result.blockedAssignmentIds).toEqual([]);
    const overridden = result.eligibility.find((e) => !e.allowed);
    expect(overridden?.covered).toBe(true);
  });
});

describe("hazard HZ-123 publishing needs the check the publisher saw", () => {
  it("hazard HZ-123 refuses a stale digest, and warnings not acknowledged", async () => {
    const rota = await getRota(rotaId);
    const stale = await as("manager", `/v1/rotas/${rotaId}/publish`, {
      method: "POST",
      body: { version: rota.version, digest: "not-the-check" },
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("check_changed");
    const seen = await check(rotaId);
    const unacknowledged = await as("manager", `/v1/rotas/${rotaId}/publish`, {
      method: "POST",
      body: {
        version: rota.version,
        digest: seen.digest,
        acknowledgedPeriods: seen.periodsToAcknowledge,
      },
    });
    expect(unacknowledged.status).toBe(422);
    expect(seen.periodsToAcknowledge.length).toBeGreaterThan(0);
    expect(((await unacknowledged.json()) as { code: string }).code).toBe(
      "warnings_not_acknowledged",
    );
  });

  it("hazard HZ-123 refuses periods short of the scale not acknowledged by name", async () => {
    const rota = await getRota(rotaId);
    const seen = await check(rotaId);
    const response = await as("manager", `/v1/rotas/${rotaId}/publish`, {
      method: "POST",
      body: { version: rota.version, digest: seen.digest, acknowledgeWarnings: true },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("periods_not_acknowledged");
  });

  it("hazard HZ-123 refuses a publisher who did not read the check themselves", async () => {
    const rota = await getRota(rotaId);
    const seen = await check(rotaId);
    const response = await as("owner", `/v1/rotas/${rotaId}/publish`, {
      method: "POST",
      body: {
        version: rota.version,
        digest: seen.digest,
        acknowledgeWarnings: true,
        acknowledgedPeriods: seen.periodsToAcknowledge,
      },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("check_not_seen");
  });

  it("hazard HZ-123 publishes with the warnings acknowledged and records the notice", async () => {
    const rota = await getRota(rotaId);
    const seen = await check(rotaId);
    const response = await as("manager", `/v1/rotas/${rotaId}/publish`, {
      method: "POST",
      body: {
        version: rota.version,
        digest: seen.digest,
        acknowledgeWarnings: true,
        acknowledgedPeriods: seen.periodsToAcknowledge,
      },
    });
    expect(response.status).toBe(200);
    const published = (await response.json()) as Rota;
    expect(published.state).toBe("published");
    expect(published.publications).toHaveLength(1);
    expect(published.publications[0]?.noticeMinutes).toBeGreaterThan(0);
    expect(published.publications[0]?.openShiftCount).toBe(seen.openShiftIds.length);
    expect(published.shifts.every((s) => s.publishedAt !== null)).toBe(true);
    const events = await sql(
      "SELECT 1 FROM outbox_event WHERE event_type = 'scheduling.rota_published' AND aggregate_id = $1",
      [rotaId],
    );
    expect(events).toHaveLength(1);
  });

  it("shows a member their own published shifts", async () => {
    const response = await as("carer", `/v1/me/shifts?from=${inDays(14)}&to=${inDays(15)}`);
    expect(response.status).toBe(200);
    const mine = (await response.json()) as { items: { label: string }[] };
    expect(mine.items.map((i) => i.label).sort()).toEqual(["Day", "Medicines round"]);
  });

  it("records a change after publishing for notice", async () => {
    const shift = (await getRota(rotaId)).shifts.find((s) => s.assignment === null) as Shift;
    const response = await as("manager", `/v1/shifts/${shift.id}/cancel`, {
      method: "POST",
      body: { version: shift.version, reason: "Fewer people staying this week" },
    });
    expect(response.status).toBe(200);
    const [row] = await sql<{ changed: boolean }>(
      "SELECT changed_after_publish_at IS NOT NULL AS changed FROM shift WHERE id = $1",
      [shift.id],
    );
    expect(row?.changed).toBe(true);
    expect((await getRota(rotaId)).changedSincePublished).toBe(true);
  });

  it("hazard HZ-124 refuses publishing when a right to work has lapsed since assigning", async () => {
    await sql(
      `UPDATE compliance_item SET verified_on = NULL, verified_by = NULL
        WHERE kind = 'right_to_work'
          AND staff_profile_id = (SELECT id FROM staff_profile WHERE tenant_user_id = $1)`,
      [CARER],
    );
    const result = await check(rotaId);
    expect(result.blockedAssignmentIds.length).toBe(2);
    const rota = await getRota(rotaId);
    const response = await as("manager", `/v1/rotas/${rotaId}/publish`, {
      method: "POST",
      body: {
        version: rota.version,
        digest: result.digest,
        acknowledgeWarnings: true,
        acknowledgedPeriods: result.periodsToAcknowledge,
      },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("ineligible_assignments");
  });
});

describe("the rota builder's picker: who works at a location", () => {
  it("lists active members with a role there or organisation-wide, for a rota manager only", async () => {
    const r = await as("manager", `/v1/locations/${LOC}/rota-workers`);
    expect(r.status).toBe(200);
    const items = ((await r.json()) as { items: { id: string; displayName: string }[] }).items;
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([CARER, NURSE, MANAGER, OWNER]));
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["displayName", "id", "jobTitle"]);
    expect((await as("carer", `/v1/locations/${LOC}/rota-workers`)).status).toBe(403);
    // A manager at one home is refused another home of the same organisation (not found), and a
    // made-up home is not found either.
    expect((await as("manager", `/v1/locations/${LODGE.locationId}/rota-workers`)).status).toBe(
      404,
    );
    expect(
      (await as("owner", "/v1/locations/0194d000-0000-7000-8000-00000000ffff/rota-workers")).status,
    ).toBe(404);
    const audited = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_event WHERE action = 'scheduling.rota_workers.listed' AND resource_id = $1",
      [LOC],
    );
    expect(audited[0]?.n).toBeGreaterThan(0);
    // Another organisation's home is not found, as for its rotas.
    expect((await as("manager", `/v1/locations/${OTHER.locationId}/rota-workers`)).status).toBe(
      404,
    );
  });
});
