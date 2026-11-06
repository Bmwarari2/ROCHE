import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  ALERT_LIST_LIMIT,
  alertsTile,
  apartLine,
  breakGlassTile,
  chooseTile,
  countLine,
  DASHBOARD_LOCATION_LIMIT,
  dashboardLocations,
  dolsTile,
  FAILED,
  FORBIDDEN,
  handoverTile,
  incidentsTile,
  locationHref,
  notificationsTile,
  ok,
  outagesTile,
  reviewsTile,
  type TileSummary,
  tasksTile,
  tileChips,
  visibleTiles,
} from "./dashboard";
import { INCIDENT_LIST_LIMIT } from "./incidents";

const t = createTranslator("en-GB");
const HOUSE = "0194d000-0000-7000-8000-000000000101";
const MEWS = "0194d000-0000-7000-8000-000000000102";

// The permissions of the demo roles that decide the tiles (docs/specs/permissions.md).
const OWNER = [
  "care.plan.read",
  "care.dols.manage",
  "care.handover.manage",
  "safety.incident.read",
  "safety.incident.manage",
  "operations.downtime.read",
  "people.person.read",
  "platform.audit.read",
];
const NURSE = [
  "care.plan.read",
  "care.handover.manage",
  "safety.incident.read",
  "people.person.read",
];
const CARER = ["care.plan.read", "people.person.read", "safety.incident.report"];

describe("which tiles a reader sees (insights.md rule 1)", () => {
  it.each([
    [
      "owner or Registered Manager",
      OWNER,
      [
        "alerts",
        "tasks",
        "handover",
        "dols",
        "reviews",
        "incidents",
        "notifications",
        "outages",
        "breakGlass",
      ],
    ],
    ["nurse", NURSE, ["alerts", "tasks", "handover", "reviews", "incidents"]],
    ["carer", CARER, ["alerts", "tasks", "reviews"]],
    ["someone with no care permissions", [], ["alerts"]],
    // DoLS needs both: the reminder's permission and the round it is listed on.
    ["DoLS manager without care plans", ["care.dols.manage"], ["alerts"]],
    // Outages are listed only to those who also see the people at the location.
    ["downtime without people", ["operations.downtime.manage"], ["alerts"]],
    ["submitter without incident management", ["safety.notification.submit"], ["alerts"]],
  ])("%s", (_, permissions, tiles) => {
    expect(visibleTiles(permissions)).toEqual(tiles);
  });
});

describe("the locations read (insights.md rules 5 and 6)", () => {
  const places = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${HOUSE.slice(0, -1)}${i}` }));

  it("reads the chosen location only", () => {
    expect(dashboardLocations(places(5), MEWS)).toEqual({ ids: [MEWS], tooMany: false });
  });

  it("reads every location up to the limit, and none past it", () => {
    expect(dashboardLocations(places(DASHBOARD_LOCATION_LIMIT), null).ids).toHaveLength(
      DASHBOARD_LOCATION_LIMIT,
    );
    expect(dashboardLocations(places(DASHBOARD_LOCATION_LIMIT + 1), null)).toEqual({
      ids: [],
      tooMany: true,
    });
  });

  it("links to one location's page, else to the page that lists them", () => {
    expect(locationHref("/round", [HOUSE])).toBe(`/round/${HOUSE}`);
    expect(locationHref("/round", [HOUSE, MEWS])).toBe("/round");
    expect(locationHref("/downtime", [])).toBe("/downtime");
  });

  it("asks for a location instead of a count", () => {
    const tile = chooseTile("tasks", "/round");
    expect(tile.count).toBeNull();
    expect(countLine(tile, t)).toMatch(/^You work at several locations/);
    expect(tileChips(tile, t)).toEqual([
      { status: "neutral", icon: "search", label: "Choose a location" },
    ]);
  });
});

const alert = (severity: string, acknowledgedAt: string | null = null) =>
  ({ severity, acknowledgedAt }) as never;

describe("alerts", () => {
  it.each([
    ["none", [], 0, 0, "clear", "No alerts waiting for you"],
    ["info only", [alert("info")], 0, 0, "clear", "No alerts waiting for you"],
    ["acknowledged", [alert("urgent", "2026-10-31T09:00:00Z")], 0, 0, "clear", null],
    ["a warning", [alert("warning")], 1, 0, "todo", "1 alert not acknowledged"],
    [
      "urgent apart",
      [alert("urgent"), alert("warning")],
      2,
      1,
      "urgent",
      "2 alerts not acknowledged",
    ],
    // A severity the web does not know is urgent, so it warns.
    ["unknown severity", [alert("critical")], 1, 1, "urgent", "1 alert not acknowledged"],
  ])("hazard HZ-008 %s", (_, items, count, apart, state, words) => {
    const tile = alertsTile(ok({ items })) as TileSummary;
    expect(tile).toMatchObject({ id: "alerts", count, apart, state, href: "/notifications" });
    if (words) expect(countLine(tile, t)).toBe(words);
  });

  it("says urgent apart", () => {
    const tile = alertsTile(ok({ items: [alert("urgent"), alert("warning")] })) as TileSummary;
    expect(apartLine(tile, t)).toBe("1 is urgent.");
  });

  it("says at least when the latest page of alerts is full", () => {
    const items = Array.from({ length: ALERT_LIST_LIMIT }, () => alert("warning"));
    const tile = alertsTile(ok({ items })) as TileSummary;
    expect(tile.partial).toBe(true);
    expect(countLine(tile, t)).toBe(`At least ${ALERT_LIST_LIMIT} alerts not acknowledged`);
  });
});

const roundOf = (tasks: { kind?: string; timeState: string }[], complete = true) => ({
  complete,
  areas: [
    {
      stops: [{ tasks: tasks.map((task) => ({ kind: "fluid_intake", ...task })) }],
    },
  ],
});

describe("tasks on the round", () => {
  const href = `/round/${HOUSE}`;
  it.each([
    ["none", [], 0, 0, "clear"],
    ["only still to come", [{ timeState: "upcoming" }], 0, 0, "clear"],
    ["due", [{ timeState: "due" }, { timeState: "upcoming" }], 1, 0, "todo"],
    [
      "overdue and escalated",
      [{ timeState: "overdue" }, { timeState: "escalated" }],
      2,
      2,
      "overdue",
    ],
    // A time state the web does not know counts as overdue, never as calm.
    ["unknown state", [{ timeState: "late" }], 1, 1, "overdue"],
    ["closed", [{ timeState: "closed" }], 0, 0, "clear"],
  ])("%s", (_, tasks, count, apart, state) => {
    expect(tasksTile([ok(roundOf(tasks) as never)], href)).toMatchObject({
      id: "tasks",
      count,
      apart,
      state,
      partial: false,
      href,
    });
  });

  it("adds up every location read", () => {
    const tile = tasksTile(
      [
        ok(roundOf([{ timeState: "due" }]) as never),
        ok(roundOf([{ timeState: "overdue" }]) as never),
      ],
      "/round",
    ) as TileSummary;
    expect(tile).toMatchObject({ count: 2, apart: 1, state: "overdue" });
    expect(countLine(tile, t)).toBe("2 tasks due or overdue");
    expect(apartLine(tile, t)).toBe("1 is overdue.");
  });

  it("says at least when the round could not list every open task", () => {
    const tile = tasksTile(
      [ok(roundOf([{ timeState: "due" }], false) as never)],
      href,
    ) as TileSummary;
    expect(tile.partial).toBe(true);
    expect(countLine(tile, t)).toBe("At least 1 task due or overdue");
    expect(tileChips(tile, t).map((c) => c.label)).toEqual(["To do", "Some not loaded"]);
  });

  it("hazard HZ-003 never says none, nor shows the all-clear, when part of it failed", () => {
    const tile = tasksTile([ok(roundOf([]) as never), FAILED], "/round") as TileSummary;
    expect(tile.partial).toBe(true);
    expect(countLine(tile, t)).toBe("None in the part that loaded");
    // Never a green "Nothing waiting" beside it: what is missing may be waiting.
    expect(tile.state).toBe("notKnown");
    expect(tileChips(tile, t)).toEqual([
      { status: "due", icon: "triangle-alert", label: "Not known" },
      { status: "due", icon: "triangle-alert", label: "Some not loaded" },
    ]);
  });

  it("warns, with no count, when nothing loaded", () => {
    const tile = tasksTile([FAILED, FAILED], "/round") as TileSummary;
    expect(tile).toMatchObject({ state: "failed", count: null });
    expect(countLine(tile, t)).toBe("Harbour could not load this. Open the list to check it.");
    expect(tileChips(tile, t)).toEqual([
      { status: "due", icon: "triangle-alert", label: "Could not load" },
    ]);
  });

  it("is hidden when every read was refused for a missing permission", () => {
    expect(tasksTile([FORBIDDEN], href)).toBeNull();
  });

  it("is a failure, not hidden, when a refusal comes with a failure", () => {
    expect(tasksTile([FORBIDDEN, FAILED], href)).toMatchObject({ state: "failed" });
  });
});

describe("DoLS reminders (care.md rule 11)", () => {
  it.each([
    ["none", [{ timeState: "due" }], 0, 0, "noneOpen", "No DoLS reminders open"],
    [
      "an open reminder, its window not yet started",
      [{ kind: "care.dols_expiry", timeState: "upcoming" }],
      1,
      0,
      "todo",
      "1 DoLS reminder open",
    ],
    [
      "an overdue reminder",
      [
        { kind: "care.dols_expiry", timeState: "overdue" },
        { kind: "care.dols_expiry", timeState: "due" },
      ],
      2,
      1,
      "overdue",
      "2 DoLS reminders open",
    ],
  ])("hazard HZ-020 %s", (_, tasks, count, apart, state, words) => {
    const tile = dolsTile([ok(roundOf(tasks) as never)], "/round") as TileSummary;
    expect(tile).toMatchObject({ id: "dols", count, apart, state });
    expect(countLine(tile, t)).toBe(words);
  });

  it("hazard HZ-020 no reminder open is said neutrally, never with the all-clear tick", () => {
    const tile = dolsTile([ok(roundOf([]) as never)], "/round") as TileSummary;
    expect(tileChips(tile, t)).toEqual([
      { status: "neutral", icon: "circle-minus", label: "None open" },
    ]);
  });
});

const handover = (
  start: string,
  end: string,
  unacknowledged: boolean | null,
  pending: string[] = [],
  acknowledgementDueAt: string | null = null,
) => ({ shift: { name: "Day", start, end }, unacknowledged, pending, acknowledgementDueAt });

describe("handover", () => {
  const now = new Date("2026-10-31T10:00:00Z");
  const running = handover("2026-10-31T08:00:00Z", "2026-10-31T20:00:00Z", false);
  const lastNight = (u: boolean | null, pending: string[] = []) =>
    handover("2026-10-30T20:00:00Z", "2026-10-31T08:00:00Z", u, pending);

  it.each([
    ["every one acknowledged", [running, lastNight(false)], 0, "clear", "compiled"],
    // "To do" while no due time is known (H-410: overdue once the grace time has passed).
    ["last night's not acknowledged", [running, lastNight(true)], 1, "todo", "compiled"],
    ["a late addition still to be seen", [running, lastNight(false, ["x"])], 1, "todo", "compiled"],
    // Limited to the reader's own people: not known, never "every one acknowledged".
    ["not known when limited", [lastNight(null)], 0, "notKnown", "notCompiled"],
  ] as const)("hazard HZ-018 %s", (_, items, count, state, current) => {
    const tile = handoverTile([ok({ items: [...items] })], `/handover/${HOUSE}`, now);
    expect(tile).toMatchObject({ id: "handover", count, state, current });
  });

  it("hazard HZ-018 the shift running now is not counted until it ends", () => {
    const tile = handoverTile(
      [ok({ items: [handover("2026-10-31T08:00:00Z", "2026-10-31T20:00:00Z", true)] })],
      "/handover",
      now,
    );
    expect(tile).toMatchObject({ count: 0, state: "clear" });
  });

  it("says whether the shift running now has one, for one location only", () => {
    const tile = handoverTile([ok({ items: [] }), ok({ items: [] })], "/handover", now);
    expect(tile?.current).toBeUndefined();
    const one = handoverTile([ok({ items: [] })], `/handover/${HOUSE}`, now) as TileSummary;
    expect(t("dashboard.tile.handover.current", { state: one.current ?? "" })).toBe(
      "The handover for the shift running now is not compiled yet.",
    );
  });

  it("says the count in words", () => {
    const tile = handoverTile([ok({ items: [lastNight(true)] })], "/handover", now) as TileSummary;
    expect(countLine(tile, t)).toBe("1 handover not acknowledged by the incoming shift");
    expect(apartLine(tile, t)).toBeNull();
  });

  it.each<[string, string | null, boolean | null, string[], string, number]>([
    // Ended 08:00 with a 60-minute grace: due 09:00, and it is 10:00.
    ["past the grace time, not acknowledged", "2026-10-31T09:00:00Z", true, [], "overdue", 1],
    ["exactly at the grace time", "2026-10-31T10:00:00Z", true, [], "overdue", 1],
    ["within the grace time", "2026-10-31T10:30:00Z", true, [], "todo", 0],
    // No figure: never late on a guess.
    ["with no due time", null, true, [], "todo", 0],
    // A late addition still to be seen is to do, never overdue.
    ["acknowledged, a late addition to see", "2026-10-31T09:00:00Z", false, ["x"], "todo", 0],
  ])(
    "hazard HZ-018 a handover %s is %s (H-410)",
    (_label, due, unacknowledged, pending, state, apart) => {
      const tile = handoverTile(
        [
          ok({
            items: [
              handover(
                "2026-10-30T20:00:00Z",
                "2026-10-31T08:00:00Z",
                unacknowledged,
                pending,
                due,
              ),
            ],
          }),
        ],
        "/handover",
        now,
      ) as TileSummary;
      expect(tile).toMatchObject({ state, apart, count: 1 });
      if (apart > 0) {
        expect(apartLine(tile, t)).toBe(
          "1 is overdue: the incoming shift has not acknowledged it and the time to do so has passed.",
        );
        expect(tileChips(tile, t)[0]).toMatchObject({ status: "overdue", label: "Overdue" });
      }
    },
  );
});

describe("reviews due", () => {
  const review = (state: string) => ({ state }) as never;
  it.each([
    ["none", [], 0, 0, "clear"],
    ["upcoming only", [review("upcoming")], 0, 0, "clear"],
    // Paused while the person is in hospital: not due, so not counted.
    ["due and paused", [review("due"), review("paused")], 1, 0, "todo"],
    ["overdue", [review("overdue"), review("due")], 2, 1, "overdue"],
    ["unknown state", [review("lapsed")], 1, 1, "overdue"],
  ])("hazard HZ-024 %s", (_, items, count, apart, state) => {
    expect(reviewsTile([ok({ items })])).toMatchObject({
      id: "reviews",
      count,
      apart,
      state,
      href: "/people/reviews",
    });
  });
});

describe("incidents open", () => {
  let n = 0;
  const incident = (status: string) => {
    n += 1;
    return { id: `i${n}`, status } as never;
  };
  it.each([
    ["none", [], [], 0, 0, "clear", "No incidents open"],
    [
      "open and under review",
      [incident("open"), incident("open")],
      [incident("under_review")],
      3,
      1,
      "todo",
      "3 incidents open",
    ],
  ])("%s", (_, open, review, count, apart, state, words) => {
    const tile = incidentsTile([
      ok({ items: open as never[] }),
      ok({ items: review as never[] }),
    ]) as TileSummary;
    expect(tile).toMatchObject({ id: "incidents", count, apart, state, href: "/incidents" });
    expect(countLine(tile, t)).toBe(words);
  });

  it("counts an incident once if it moved between the two reads", () => {
    const same = { id: "x", status: "under_review" } as never;
    const tile = incidentsTile([ok({ items: [same] }), ok({ items: [same] })]) as TileSummary;
    expect(tile.count).toBe(1);
  });

  it("says at least past the API's limit", () => {
    const items = Array.from({ length: INCIDENT_LIST_LIMIT }, () => incident("open"));
    const tile = incidentsTile([ok({ items }), ok({ items: [] })]) as TileSummary;
    expect(tile.partial).toBe(true);
    expect(countLine(tile, t)).toBe(`At least ${INCIDENT_LIST_LIMIT} incidents open`);
  });

  it("warns when it could not be read, and hides when refused", () => {
    expect(incidentsTile([FAILED, FAILED])).toMatchObject({ state: "failed", count: null });
    expect(incidentsTile([FORBIDDEN, FORBIDDEN])).toBeNull();
  });
});

describe("statutory notifications (HZ-013)", () => {
  const notification = (clock: string, dueAt = "2026-10-31T12:00:00Z") =>
    ({ clock, dueAt }) as never;
  it.each([
    ["none", [[], []], 0, 0, "clear"],
    ["due", [[notification("due")], []], 1, 0, "todo"],
    ["overdue", [[notification("overdue")], [notification("due")]], 2, 1, "overdue"],
    // A clock the web does not know is overdue, never calm.
    ["unknown clock", [[notification("paused")], []], 1, 1, "overdue"],
  ])("hazard HZ-013 %s", (_, [draft, ready], count, apart, state) => {
    const tile = notificationsTile([
      ok({ items: draft ?? [] }),
      ok({ items: ready ?? [] }),
    ]) as TileSummary;
    expect(tile).toMatchObject({ id: "notifications", count, apart, state });
  });

  it("hazard HZ-013 warns when either read fails, never a lower count", () => {
    const tile = notificationsTile([ok({ items: [notification("due")] }), FAILED]) as TileSummary;
    expect(tile).toMatchObject({ state: "failed", count: null });
  });

  it.each([
    ["a death notification, due without delay", "cqc_reg16_death", true],
    ["a RIDDOR report, with a report-by date", "riddor_over_7_day", undefined],
    ["a notification of an unknown kind", "something_new", undefined],
  ])("hazard HZ-013 words %s as the incident page does (H-410)", (_label, kind, withoutDelay) => {
    const tile = notificationsTile([
      ok({
        items: [{ ...(notification("overdue", "2026-10-30T09:00:00Z") as object), kind } as never],
      }),
      ok({ items: [] }),
    ]) as TileSummary;
    expect(tile.earliestWithoutDelay).toBe(withoutDelay);
    expect(
      t("dashboard.tile.notifications.earliestWithoutDelay", { dateTime: "30/10/2026 09:00" }),
    ).toBe("The soonest must be sent without delay: the clock started 30/10/2026 09:00.");
  });

  it("hazard HZ-013 gives the soonest due time of those still to submit", () => {
    const tile = notificationsTile([
      ok({ items: [notification("due", "2026-11-02T09:00:00Z")] }),
      ok({
        items: [
          notification("overdue", "2026-10-30T09:00:00Z"),
          notification("done", "2026-10-01T09:00:00Z"),
        ],
      }),
    ]) as TileSummary;
    expect(tile.earliestDue).toBe("2026-10-30T09:00:00Z");
  });

  it("hazard HZ-013 says the overdue ones apart", () => {
    const tile = notificationsTile([
      ok({ items: [notification("overdue")] }),
      ok({ items: [] }),
    ]) as TileSummary;
    expect(countLine(tile, t)).toBe("1 notification to submit");
    expect(apartLine(tile, t)).toBe("1 is overdue.");
  });
});

describe("outages (operations.md)", () => {
  const outage = (state: string) => ({ state }) as never;
  it.each([
    ["none", [], 0, 0, "clear"],
    ["finished", [outage("reconciled"), outage("cancelled")], 0, 0, "clear"],
    ["to reconcile", [outage("closed")], 1, 0, "todo"],
    ["under way", [outage("declared"), outage("closed")], 2, 1, "urgent"],
    ["unknown state", [outage("paused")], 1, 1, "urgent"],
  ])("%s", (_, items, count, apart, state) => {
    expect(outagesTile([ok({ items })], "/downtime")).toMatchObject({
      id: "outages",
      count,
      apart,
      state,
    });
  });

  it("says urgent with a warning icon and word", () => {
    const tile = outagesTile([ok({ items: [outage("declared")] })], "/downtime") as TileSummary;
    expect(tileChips(tile, t)).toEqual([
      { status: "overdue", icon: "triangle-alert", label: "Urgent" },
    ]);
    expect(apartLine(tile, t)).toBe("1 is under way.");
  });
});

describe("break-glass reports (HZ-011)", () => {
  const report = (id: string, locationId: string, supersedesId: string | null = null) => ({
    id,
    locationId,
    supersedesId,
    reviewedAt: supersedesId ? "2026-10-28T09:00:00Z" : null,
    reviewedBy: null,
    actionsTaken: null,
  });

  it("counts the reports not yet reviewed, at the chosen location if any", () => {
    const items = [report("a", HOUSE), report("b", MEWS), report("c", HOUSE, "a")];
    expect(breakGlassTile(ok({ items }), null)).toMatchObject({ count: 1, state: "todo" });
    expect(breakGlassTile(ok({ items }), HOUSE)).toMatchObject({ count: 0, state: "clear" });
    const tile = breakGlassTile(ok({ items }), MEWS) as TileSummary;
    expect(countLine(tile, t)).toBe("1 report to review");
    expect(apartLine(tile, t)).toBeNull();
  });

  it("says when every report is reviewed", () => {
    const tile = breakGlassTile(ok({ items: [] }), null) as TileSummary;
    expect(countLine(tile, t)).toBe("Every report for last week reviewed");
    expect(tileChips(tile, t)).toEqual([
      { status: "done", icon: "circle-check", label: "Nothing waiting" },
    ]);
  });
});

describe("words", () => {
  it("warns for a state the web does not know", () => {
    expect(tileChips({ state: "paused" as never, partial: false }, t)).toEqual([
      { status: "overdue", icon: "triangle-alert", label: "Not known" },
    ]);
  });
});
