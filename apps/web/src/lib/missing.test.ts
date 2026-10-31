import type { Translator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  kindsFor,
  missingShown,
  missingStatusChip,
  policeCallChip,
  policeCallState,
  prefillSources,
  readHerbertProfile,
  readOpenEpisode,
  readTimelineEntry,
} from "./missing";

/** Phase 2 slice 63: the pure parts of the missing person screens and the Herbert profile. */

// A stand-in translator: the key and its values, so these tests check what is said, not the copy.
const t = ((key: string, values?: Record<string, unknown>) =>
  `${key} ${JSON.stringify(values ?? {})}`) as unknown as Translator;

const ID = "0199f000-0000-7000-8000-0000000000b1";
const NOW = new Date("2026-10-31T12:00:00Z");

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}
const when = (name: string, [d, m, y, h, min]: readonly string[]) => ({
  [`${name}-day`]: d ?? "",
  [`${name}-month`]: m ?? "",
  [`${name}-year`]: y ?? "",
  [`${name}-hour`]: h ?? "",
  [`${name}-minute`]: min ?? "",
});

describe("missing persons", () => {
  it("is shown to whoever reads incidents", () => {
    expect(missingShown(["safety.incident.read"])).toBe(true);
    expect(missingShown(["care.plan.read"])).toBe(false);
  });

  it("offers the welfare check and debrief only to a manager", () => {
    expect(kindsFor(["safety.incident.manage"])).toContain("debrief");
    const reporter = kindsFor(["safety.incident.report"]);
    expect(reporter).toContain("police_called");
    expect(reporter).not.toContain("welfare_check");
    expect(kindsFor([])).toEqual([]);
  });

  it.each([
    ["open", "overdue", "circle-alert"],
    ["found", "due", "clock"],
    ["closed", "done", "circle-check"],
    ["vanished", "overdue", "triangle-alert"],
  ])("names status %s as an icon and a word", (status, chipStatus, icon) => {
    const chip = missingStatusChip(status, t);
    expect(chip).toMatchObject({ status: chipStatus, icon });
    expect(chip.label.length).toBeGreaterThan(0);
  });

  it.each([
    [{ status: "open", policeCallDueAt: "x", policeCallLate: true }, "overdue"],
    [{ status: "open", policeCallDueAt: "x", policeCallLate: false, immediateRisk: true }, "now"],
    [{ status: "open", policeCallDueAt: "x", policeCallLate: false }, "due"],
    [{ status: "open", policeCallDueAt: null, policeCallLate: false }, "now"],
    [
      { status: "open", policeCallDueAt: "x", policeCallLate: true, policeReference: "CAD 1" },
      "called",
    ],
    [{ status: "found", policeCallDueAt: "x", policeCallLate: false }, "not_needed"],
  ] as const)("puts the police call first: %o is %s", (episode, state) => {
    expect(policeCallState(episode)).toBe(state);
  });

  it("says the police call in words with the target time, never by colour alone", () => {
    const chip = policeCallChip("overdue", "31/10/2026 12:30", t);
    expect(chip).toMatchObject({ status: "overdue", icon: "circle-alert" });
    expect(chip.label).toContain("31/10/2026 12:30");
    expect(policeCallChip("called", "", t).icon).toBe("send");
  });

  it("opens an episode with when they were noticed missing and the risk answer", () => {
    const read = readOpenEpisode(
      form({ ...when("noticedMissingAt", ["31", "10", "2026", "11", "30"]), immediateRisk: "yes" }),
      t,
      { id: ID, incidentId: ID, personId: ID, now: NOW },
    );
    expect(read).toMatchObject({ ok: true, body: { immediateRisk: true, lastSeenAt: null } });
    const empty = readOpenEpisode(form({}), t, { id: ID, incidentId: ID, personId: ID, now: NOW });
    expect(empty.ok).toBe(false);
    if (!empty.ok)
      expect(Object.keys(empty.errors).sort()).toEqual(["immediateRisk", "noticedMissingAt"]);
  });

  it("refuses last seen after noticed missing", () => {
    const read = readOpenEpisode(
      form({
        ...when("noticedMissingAt", ["31", "10", "2026", "10", "00"]),
        ...when("lastSeenAt", ["31", "10", "2026", "11", "00"]),
        immediateRisk: "no",
      }),
      t,
      { id: ID, incidentId: ID, personId: ID, now: NOW },
    );
    expect(read.ok).toBe(false);
  });

  it.each([
    [{ kind: "police_called" }, false],
    [{ kind: "police_called", reference: "CAD 4471" }, true],
    [{ kind: "note" }, false],
    [{ kind: "note", note: "Searched the garden." }, true],
    [{ kind: "search", area: "The park" }, true],
    [{ kind: "made_up" }, false],
  ] as const)("reads a timeline entry %o", (values, ok) => {
    const read = readTimelineEntry(
      form({ ...values, ...when("at", ["31", "10", "2026", "11", "45"]) }),
      t,
      { id: ID, now: NOW },
    );
    expect(read.ok).toBe(ok);
  });

  it("needs what the person looks like and where they may go, and a real review date", () => {
    const missing = readHerbertProfile(form({}), t, { version: 0, today: "2026-10-31" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(Object.keys(missing.errors).sort()).toEqual(
        ["physicalDescription", "placesLikely", "reviewedOn"].sort(),
      );
    }
    const read = readHerbertProfile(
      form({
        physicalDescription: "Short, grey hair, glasses.",
        placesLikely: "The old family home on Example Street.",
        routines: "Walks after lunch.",
        "reviewedOn-day": "30",
        "reviewedOn-month": "10",
        "reviewedOn-year": "2026",
      }),
      t,
      { version: 2, today: "2026-10-31" },
    );
    expect(read).toMatchObject({
      ok: true,
      body: {
        version: 2,
        reviewedOn: "2026-10-30",
        mobility: null,
        routines: "Walks after lunch.",
      },
    });
    const future = readHerbertProfile(
      form({
        physicalDescription: "x x x",
        placesLikely: "y y y",
        "reviewedOn-day": "01",
        "reviewedOn-month": "11",
        "reviewedOn-year": "2026",
      }),
      t,
      { version: 0, today: "2026-10-31" },
    );
    expect(future.ok).toBe(false);
  });

  it("names where each prefilled part came from", () => {
    expect(prefillSources(null)).toEqual([]);
    expect(prefillSources("From the record: Hard of hearing\nFrom About Me: Speak slowly")).toEqual(
      ["record", "about_me"],
    );
    expect(prefillSources("Allergies (from the record): penicillin")).toEqual(["record"]);
  });
});
