import { DEVICE_HEADER } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Back-entry through the care write routes (operations.md rules 11 to 13 and section 12; OPS-028;
 * hazards HZ-017 and HZ-006): a paper record keeps the time written on the form and its label on
 * every care route; an entry written later for a time inside an outage says whether it is from
 * paper; a reconciled outage takes no new paper records; a paper record is corrected once, and a
 * device's second correction goes to the refused-entry review; a correction whose time is now
 * after the outage's true end asks why (H-208).
 */

let h: Harness;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const PERSON = resident(1);
/** An instant `ms` ago, to the minute (a paper time has no seconds). */
const ago = (ms: number) => new Date(Math.floor((Date.now() - ms) / MINUTE) * MINUTE);
const newId = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
};

const as = (
  who: string | { token: string },
  path: string,
  init: { method?: string; body?: unknown; device?: string } = {},
) =>
  h.request(path, {
    method: init.method,
    body: init.body,
    token: typeof who === "string" ? h.tokens[who] : who.token,
    tenant: DEMO.tenantId,
    headers: init.device ? { [DEVICE_HEADER]: init.device } : {},
  });

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

/** The date and time a paper form would show for an instant, in UK time. */
function paperOf(at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    paperDate: `${parts.year}-${parts.month}-${parts.day}`,
    paperTime: `${parts.hour}:${parts.minute}`,
  };
}

/** The five care write routes, each with a body of its own kind. */
const ROUTES = [
  ["notes", "care_note", { category: "personal_care", body: "Assisted with a wash." }],
  [
    "observations",
    "observation",
    { values: { chart: "repositioning", position: "left", skinChecked: true } },
  ],
  [
    "body-map",
    "body_map_mark",
    {
      view: "back",
      region: "heel",
      drawnAt: { x: 45, y: 230 },
      drawnSide: "left",
      side: "left",
      markType: "pressure_ulcer",
      pressureCategory: "category_1",
      deviceRelated: false,
    },
  ],
  [
    "activities",
    "activity_record",
    {
      activity: "Music group",
      format: "one_to_one",
      attendance: "attended",
      engagement: "engaged_throughout",
    },
  ],
  ["visits", "visit_log", { kind: "visit_out", visitorName: "Visitor Example" }],
] as const;

const write = (
  route: string,
  body: Record<string, unknown>,
  who: string | { token: string } = "carer",
  device?: string,
) =>
  as(who, `/v1/people/${PERSON}/${route}`, {
    method: "POST",
    body,
    ...(device ? { device } : {}),
  });

interface Outage {
  id: string;
  version: number;
}

async function declare(startedAt: Date, endedAt: Date | null): Promise<Outage> {
  const response = await as("manager", `/v1/locations/${DEMO.locationId}/outages`, {
    method: "POST",
    body: {
      kind: "power",
      description: "Power cut, whole building",
      startedAt: startedAt.toISOString(),
      ...(endedAt ? { endedAt: endedAt.toISOString() } : {}),
    },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Outage;
}

interface Entry {
  id: string;
  occurredAt: string;
  backEntry: {
    outageId: string;
    paperDate: string;
    paperTime: string;
    label: string | null;
  } | null;
  notFromPaper: { outageId: string; reason: string } | null;
}

/** An outage from 5 to 3 hours ago, declared after it ended. */
let past: Outage;

beforeAll(async () => {
  h = await createHarness();
  past = await declare(ago(5 * HOUR), ago(3 * HOUR));
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-017 back-entry through each care route", () => {
  it.each(ROUTES)(
    "hazard HZ-017 a back-entry through %s keeps the paper time and shows the label",
    async (route, table, body) => {
      const at = ago(4 * HOUR);
      const response = await write(route, {
        ...body,
        occurredAt: at.toISOString(),
        backEntry: { outageId: past.id, ...paperOf(at), paperReference: "DT-001" },
      });
      expect(response.status).toBe(201);
      const saved = (await response.json()) as Entry;
      expect(new Date(saved.occurredAt).getTime()).toBe(at.getTime());
      expect(saved.backEntry).toMatchObject({ outageId: past.id, ...paperOf(at) });
      expect(saved.backEntry?.label).toMatch(
        /^Written on paper .* during the outage \(power cut\)/,
      );
      expect(saved.notFromPaper).toBeNull();
      const [stored] = await sql<{ late_entry_reason: string; outage_id: string }>(
        `SELECT late_entry_reason, outage_id FROM ${table} WHERE id = $1`,
        [saved.id],
      );
      expect(stored).toEqual({ late_entry_reason: "downtime", outage_id: past.id });
      const [audited] = await sql<{ scope: Record<string, unknown> }>(
        "SELECT scope FROM audit_event WHERE resource_id = $1",
        [saved.id],
      );
      expect(audited?.scope).toMatchObject({ outageId: past.id, backEntry: true });
    },
  );

  it.each(ROUTES)(
    "hazard HZ-017 through %s, an entry written later for a time inside an outage says whether it is from paper",
    async (route, _table, body) => {
      const at = ago(4 * HOUR + 10 * MINUTE).toISOString();
      const refused = await write(route, { ...body, occurredAt: at });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ code: "back_entry_details_required" });
      const explained = await write(route, {
        ...body,
        occurredAt: at,
        notFromPaperReason: "Recorded from memory with the nurse in charge",
      });
      expect(explained.status).toBe(201);
      expect(((await explained.json()) as Entry).notFromPaper).toEqual({
        outageId: past.id,
        reason: "Recorded from memory with the nurse in charge",
      });
      // Written at the time on a device that kept working offline: ordinary.
      const offline = await write(route, {
        ...body,
        occurredAt: at,
        deviceTime: ago(4 * HOUR + 5 * MINUTE).toISOString(),
      });
      expect(offline.status).toBe(201);
      expect(await offline.json()).toMatchObject({ backEntry: null, notFromPaper: null });
    },
  );
});

describe("hazard HZ-017 back-entry refusals in words", () => {
  const note = ROUTES[0][2];
  const at = ago(4 * HOUR + 20 * MINUTE);
  it.each([
    [
      "an outage that is not there",
      { occurredAt: at, backEntry: { outageId: crypto.randomUUID(), ...paperOf(at) } },
      "back_entry_refused",
      /outage was not found/,
    ],
    [
      "a paper time outside the outage with no reason",
      { occurredAt: ago(2 * HOUR), backEntry: { outageId: "PAST", ...paperOf(ago(2 * HOUR)) } },
      "back_entry_refused",
      /outside the outage/,
    ],
    [
      "an entry time that is not the paper time",
      { occurredAt: ago(4 * HOUR), backEntry: { outageId: "PAST", ...paperOf(at) } },
      "back_entry_refused",
      /date and time written on the form/,
    ],
    [
      "a paper time in the hour the clocks went forward",
      {
        occurredAt: new Date("2026-03-29T01:30:00Z"),
        backEntry: { outageId: "PAST", paperDate: "2026-03-29", paperTime: "01:30" },
      },
      "back_entry_refused",
      /clocks went forward/,
    ],
    [
      "a paper record with a reason it was not on paper",
      {
        occurredAt: at,
        notFromPaperReason: "Recorded from memory with the nurse in charge",
        backEntry: { outageId: "PAST", ...paperOf(at) },
      },
      "back_entry_refused",
      /does not need a reason/,
    ],
  ] as const)("hazard HZ-017 refuses %s", async (_case, given, code, words) => {
    const named: string = given.backEntry.outageId;
    const backEntry = { ...given.backEntry, outageId: named === "PAST" ? past.id : named };
    const response = await write("notes", {
      ...note,
      ...given,
      occurredAt: given.occurredAt.toISOString(),
      backEntry,
    });
    expect(response.status).toBe(422);
    const problem = (await response.json()) as { code: string; detail: string };
    expect(problem.code).toBe(code);
    expect(problem.detail).toMatch(words);
  });

  it("hazard HZ-017 a reconciled outage takes no new paper records, and says to give the form to the Registered Manager (H-204)", async () => {
    const earlier = await declare(ago(30 * HOUR), ago(29 * HOUR));
    // Declared after it ended, it is closed at once.
    const reconciled = await as("owner", `/v1/outages/${earlier.id}/reconcile`, {
      method: "POST",
      body: {
        statement: "No paper forms were used",
        reviewedEntryIds: [],
        version: earlier.version,
      },
    });
    expect(reconciled.status).toBe(200);
    const at = ago(29 * HOUR + 30 * MINUTE);
    const response = await write("notes", {
      ...note,
      occurredAt: at.toISOString(),
      backEntry: { outageId: earlier.id, ...paperOf(at) },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "outage_reconciled",
      detail:
        "This outage has been reconciled, so this paper record cannot be added to it. Give the paper form to the Registered Manager.",
    });
  });
});

describe("hazard HZ-017 hazard HZ-006 corrections of paper records", () => {
  const note = ROUTES[0][2];

  it("hazard HZ-017 hazard HZ-006 corrects a paper record once; a device's second correction goes to the refused-entry review", async () => {
    const at = ago(3 * HOUR + 30 * MINUTE);
    const first = await write("notes", {
      ...note,
      occurredAt: at.toISOString(),
      backEntry: { outageId: past.id, ...paperOf(at) },
    });
    const original = (await first.json()) as Entry;
    const correct = (who: string | { token: string } = "carer", device?: string, id?: string) =>
      write(
        "notes",
        {
          ...note,
          ...(id ? { id } : {}),
          body: "Assisted with a wash and a shave.",
          occurredAt: at.toISOString(),
          supersedesId: original.id,
          correctionReason: "Left out the shave",
        },
        who,
        device,
      );
    const corrected = await correct();
    expect(corrected.status).toBe(201);
    // The paper details are carried from the record it corrects.
    expect(((await corrected.json()) as Entry).backEntry).toMatchObject({
      outageId: past.id,
      ...paperOf(at),
    });
    const again = await correct();
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      code: "back_entry_already_corrected",
      detail: "Reload it and correct the current version.",
    });

    const device = crypto.randomUUID();
    const entryId = newId();
    const offline = await correct("carer", device, entryId);
    expect(offline.status).toBe(409);
    expect(((await offline.json()) as { detail: string }).detail).toMatch(
      /The nurse in charge has a task to review it/,
    );
    const copies = await sql<{ refusal_code: string; review_task_id: string | null }>(
      "SELECT refusal_code, review_task_id FROM refused_entry WHERE entry_id = $1",
      [entryId],
    );
    expect(copies).toEqual([
      { refusal_code: "back_entry_already_corrected", review_task_id: expect.any(String) },
    ]);
  });

  it("hazard HZ-017 asks for an outside-the-outage reason when correcting a paper record after the true end (H-208)", async () => {
    const running = await declare(ago(2 * HOUR), null);
    const at = ago(30 * MINUTE);
    const entered = await write("notes", {
      ...note,
      occurredAt: at.toISOString(),
      backEntry: { outageId: running.id, ...paperOf(at) },
    });
    expect(entered.status).toBe(201);
    const paper = (await entered.json()) as Entry;
    // The true end, given on closing, is before the paper record (H-207).
    const closed = await as("manager", `/v1/outages/${running.id}/close`, {
      method: "POST",
      body: { endedAt: ago(HOUR).toISOString(), version: running.version },
    });
    expect(closed.status).toBe(200);
    const correction = {
      ...note,
      body: "Assisted with a wash; skin intact.",
      occurredAt: at.toISOString(),
      supersedesId: paper.id,
      correctionReason: "Added the skin check",
    };
    const asked = await write("notes", correction);
    expect(asked.status).toBe(422);
    const problem = (await asked.json()) as { code: string; detail: string };
    expect(problem.code).toBe("outside_outage_reason_required");
    expect(problem.detail).toMatch(
      /^This paper record's time is after the outage ended at .*Say why/,
    );
    const explained = await write("notes", {
      ...correction,
      backEntry: {
        outageId: running.id,
        ...paperOf(at),
        outsideOutageReason: "Form dated after the power came back",
      },
    });
    expect(explained.status).toBe(201);
    expect(((await explained.json()) as Entry).backEntry).toMatchObject({
      outsideOutageReason: "Form dated after the power came back",
    });
  });
});

describe("hazard HZ-017 correcting a closed outage (#51 review round 2)", () => {
  it("hazard HZ-017 cannot move a closed outage's end past its closure plus sync.clock_drift_flag_minutes", async () => {
    const [rate] = await sql<{ value: string }>(
      "SELECT value FROM rate_table WHERE key = 'sync.clock_drift_flag_minutes' AND tenant_id IS NULL ORDER BY valid_from DESC LIMIT 1",
    );
    const drift = Number(rate?.value) * MINUTE;
    // Declared after it ended, so closed at once (the window after the H-208 test's outage).
    const ended = await declare(ago(20 * MINUTE), ago(10 * MINUTE));
    const [row] = await sql<{ closed_at: Date }>("SELECT closed_at FROM outage WHERE id = $1", [
      ended.id,
    ]);
    const closed = new Date(row?.closed_at ?? 0).getTime();
    const correct = (endedAt: number) =>
      as("manager", `/v1/outages/${ended.id}/correct`, {
        method: "POST",
        body: {
          startedAt: ago(20 * MINUTE).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          reason: "The end was typed wrongly",
          version: ended.version,
        },
      });
    const past = await correct(closed + drift + 2 * MINUTE);
    expect(past.status).toBe(422);
    expect(((await past.json()) as { detail: string }).detail).toMatch(
      /The outage cannot end after it was closed/,
    );
    // Within the clock tolerance of the closure, a slightly fast clock's end is taken.
    const within = await correct(closed + drift - MINUTE);
    expect(within.status).toBe(200);
  });
});
