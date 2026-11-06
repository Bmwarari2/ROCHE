import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  backEntryLabel,
  downtimeAccess,
  downtimeNavShown,
  entryReference,
  entryTab,
  OUTAGE_KINDS,
  outageActions,
  outageStateChip,
  outageTitle,
  outageWindow,
  packFreshnessChip,
  printFailureTarget,
  printProblem,
  printProblemWords,
  retryAt,
  reviewEntryLine,
  reviewedEntryIds,
  reviewItems,
} from "./downtime";

const t = createTranslator("en-GB");
const HOME = "0194d000-0000-7000-8000-000000000101";
const OTHER = "0194d000-0000-7000-8000-000000000150";
const location = (id: string) => ({
  id,
  name: "Harbour House",
  regulator: "cqc" as const,
  regulatorLocationId: null,
  nation: "england" as const,
});

describe("outages on the downtime page (operations.md rules 9 to 15; HZ-017)", () => {
  it.each([
    ["declared", "due", "clock", "Open"],
    ["closed", "due", "file-pen", "Closed: paper records to enter"],
    ["reconciled", "done", "circle-check", "Reconciled"],
    ["cancelled", "notApplicable", "circle-minus", "Cancelled"],
    ["paused", "overdue", "circle-alert", "State not known: ask the Registered Manager"],
  ])("says %s in an icon and words, never colour alone", (state, status, icon, label) => {
    expect(outageStateChip(state, t)).toEqual({ status, icon, label });
  });

  it("names every outage kind in words", () => {
    for (const kind of OUTAGE_KINDS.filter((k) => k !== "other")) {
      expect(t("operations.outage.kind", { kind })).not.toBe("Other");
    }
    expect(t("operations.outage.kind", { kind: "other" })).toBe("Other");
  });

  it("titles an outage by its kind and start, and says when it is still open", () => {
    const item = { kind: "power" as const, startedAt: "2026-10-16T08:00:00Z", endedAt: null };
    expect(outageTitle(item, t)).toBe("Power cut, from 16/10/2026 09:00");
    expect(outageWindow(item, t)).toBe("From 16/10/2026 09:00, still open");
    expect(outageWindow({ ...item, endedAt: "2026-10-16T10:30:00Z" }, t)).toBe(
      "From 16/10/2026 09:00 to 16/10/2026 11:30",
    );
  });

  it.each([
    ["declared", true, { close: true, cancel: true, correct: true, reconcile: false }],
    ["closed", true, { close: false, cancel: false, correct: true, reconcile: true }],
    ["reconciled", true, { close: false, cancel: false, correct: false, reconcile: false }],
    ["cancelled", true, { close: false, cancel: false, correct: false, reconcile: false }],
    ["declared", false, { close: false, cancel: false, correct: false, reconcile: false }],
    ["closed", false, { close: false, cancel: false, correct: false, reconcile: false }],
  ])("offers on a %s outage (manage %s) only what the API would accept", (state, manage, out) => {
    expect(outageActions(state, manage)).toEqual(out);
  });
});

describe("what the location page offers (ADR-0071)", () => {
  it.each([
    [["operations.downtime.read"], true],
    [["operations.downtime.manage"], true],
    [["people.person.read", "care.note.write"], false],
  ])("shows Downtime in the navigation for %o: %s", (permissions, shown) => {
    expect(downtimeNavShown(permissions)).toBe(shown);
  });

  it("offers nothing at a location the viewer does not work at", () => {
    const me = { permissions: ["operations.downtime.manage"], locations: [location(HOME)] };
    expect(downtimeAccess(me, OTHER)).toBeNull();
  });

  it.each([
    [["people.person.read"], { pack: false, manage: false, outages: true }],
    [
      ["operations.downtime.read", "people.person.read"],
      { pack: true, manage: false, outages: true },
    ],
    [
      ["operations.downtime.manage", "operations.downtime.read", "people.person.read"],
      { pack: true, manage: true, outages: true },
    ],
  ])("follows the permissions held (%o)", (permissions, out) => {
    expect(downtimeAccess({ permissions, locations: [location(HOME)] }, HOME)).toEqual(out);
  });
});

describe("the downtime pack's freshness (HZ-021)", () => {
  it.each([
    ["current", "done", "circle-check", "In date"],
    ["outage", "due", "clock", "Latest available during the outage"],
    ["out_of_date", "overdue", "triangle-alert", "Out of date"],
    ["clock_behind", "overdue", "triangle-alert", "Check this device's clock"],
    ["unknown", "overdue", "triangle-alert", "Freshness not known: check with the nurse in charge"],
  ])("says %s in an icon and words", (state, status, icon, label) => {
    expect(packFreshnessChip(state, t)).toEqual({ status, icon, label });
  });

  it.each([
    [403, "step_up_required", `/sign-in?reason=step-up&next=%2Fdowntime%2F${HOME}`],
    [401, "unauthenticated", `/sign-in?next=%2Fdowntime%2F${HOME}`],
    [429, "rate_limited", `/downtime/${HOME}?print=limited`],
    [503, "downtime_pack_unavailable", `/downtime/${HOME}?print=unavailable`],
    [404, "not_found", `/downtime/${HOME}?print=forbidden`],
    [403, "missing_permission", `/downtime/${HOME}?print=forbidden`],
    [500, "internal", `/downtime/${HOME}?print=failed`],
  ])("a print refused with %i %s goes where the person can act", (status, code, target) => {
    expect(printFailureTarget(HOME, status, code)).toBe(target);
  });

  it("says when the pack can be opened again over the hourly limit, without blame", () => {
    const now = new Date("2026-10-16T13:00:00Z");
    const target = printFailureTarget(HOME, 429, "rate_limited", "600", now);
    expect(target).toBe(`/downtime/${HOME}?print=limited&from=2026-10-16T13%3A10%3A00.000Z`);
    expect(retryAt("600", now)).toBe("2026-10-16T13:10:00.000Z");
    expect(retryAt("soon", now)).toBeNull();
    expect(retryAt(null, now)).toBeNull();
    expect(printProblemWords("limited", "2026-10-16T13:10:00.000Z", t)).toEqual({
      title: "The pack has been opened the most times allowed this hour",
      hint: "You can open it again from 14:10. Until then, use the last printed pack and ask the nurse in charge about any change since.",
    });
    expect(printProblemWords("forbidden", null, t).title).toBe("You cannot print the pack here");
  });

  it("reads only the print problems it knows from the address", () => {
    expect(printProblem("limited")).toBe("limited");
    expect(printProblem("forbidden")).toBe("forbidden");
    expect(printProblem("<script>")).toBeNull();
    expect(printProblem(undefined)).toBeNull();
  });
});

describe("hazard HZ-092 reconciling an outage (operations.md section 12, #38 review round 2)", () => {
  const reconciliation = {
    duplicateGroups: [["a1", "a2"], [], ["b1", "b2", "b3"]],
    outsideWindowEntryIds: ["c1", "a1"],
  };

  it("hazard HZ-092 lists each possible duplicate group and each back-entry outside the window", () => {
    expect(reviewItems(reconciliation).map((i) => [i.key, i.kind, i.entryIds])).toEqual([
      ["duplicate-0", "duplicate", ["a1", "a2"]],
      ["duplicate-1", "duplicate", ["b1", "b2", "b3"]],
      ["outside-c1", "outside", ["c1"]],
      ["outside-a1", "outside", ["a1"]],
    ]);
  });

  it("hazard HZ-092 sends the reviewed ids, once each, only when every item is ticked", () => {
    const items = reviewItems(reconciliation);
    expect(reviewedEntryIds(items, new Set(["duplicate-0", "outside-c1"]))).toBeNull();
    expect(reviewedEntryIds(items, new Set(items.map((i) => i.key)))).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
      "b3",
      "c1",
    ]);
    expect(reviewedEntryIds([], new Set())).toEqual([]);
  });

  it("hazard HZ-092 gives each entry to review its person, kind and time, with its record's tab (H-267)", () => {
    const entry = (id: string, kind: string, person: boolean) => ({
      id: `0194d000-0000-7000-8600-0000000000${id}`,
      personId: "0194d000-0000-7000-8600-000000000001",
      person: person ? { givenName: "Ada", familyName: "Example", preferredName: null } : null,
      kind,
      occurredAt: "2026-10-16T07:15:00.000Z",
      source: "back_entry" as const,
      paperReference: null,
    });
    const items = reviewItems({
      duplicateGroups: [
        [entry("a1", "observation.fluid_intake", true).id, entry("a2", "care_note", true).id],
      ],
      outsideWindowEntryIds: [entry("c1", "body_map_mark", false).id],
      reviewEntries: [
        entry("c1", "body_map_mark", false),
        entry("a2", "care_note", true),
        entry("a1", "observation.fluid_intake", true),
      ],
    });
    expect(items.map((i) => i.entries.map((e) => e.id.slice(-2)))).toEqual([["a1", "a2"], ["c1"]]);
    const [fluid, note] = items[0]?.entries ?? [];
    expect(fluid && reviewEntryLine(fluid, t)).toBe(
      "Ada Example: Fluid intake, 16/10/2026 08:15, entered from paper (reference 000000A1)",
    );
    expect(note && reviewEntryLine(note, t)).toMatch(/^Ada Example: Care note, /);
    // Someone the reader cannot see is not named, and gets no link.
    const hidden = items[1]?.entries[0];
    expect(hidden && reviewEntryLine(hidden, t)).toMatch(
      /^Someone you cannot see: Body map mark, /,
    );
    expect(
      ["observation.vitals", "care_note", "body_map_mark", "activity_record", "visit_log"].map(
        entryTab,
      ),
    ).toEqual(["charts", "notes", "body-map", "activities", "activities"]);
  });

  it("hazard HZ-092 gives the short reference the record shows beside the paper label", () => {
    expect(entryReference("0194d000-0000-7000-8600-0000abcdef12")).toBe("ABCDEF12");
  });
});

describe("hazard HZ-017 a back-entered record never reads as written at the time", () => {
  const entry = {
    outageId: "0194d000-0000-7000-8000-000000000999",
    paperDate: "2026-10-16",
    paperTime: "09:15",
    occurrence: "only" as const,
    outsideOutageReason: null,
    paperReference: null,
  };

  it("shows the API's label", () => {
    const label = "Entered from a paper record: written 16/10/2026 09:15 during the power cut";
    expect(backEntryLabel({ ...entry, label }, t)).toBe(label);
  });

  it("falls back to the paper date and time when the outage cannot be read", () => {
    expect(backEntryLabel({ ...entry, label: null }, t)).toBe(
      "Entered later from a paper record written 16/10/2026 at 09:15",
    );
  });
});
