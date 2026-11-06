import type { DeathView } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import {
  canManageDeaths,
  deathStatusChip,
  deathStepChip,
  deathsShown,
  exitRecordFrom,
  isNotificationStep,
  NOTIFICATION_STEPS,
  notificationHref,
  notNeededAllowed,
  POLICE_STEPS,
  readDeathReview,
  readDeathStep,
  readJudgement,
  recordableHere,
  reviewChip,
  stepsToShow,
} from "./deaths";
import { t } from "./i18n";

/** Echoes the key: for messages whose strings are added with the catalogue merge. */
const tk = ((key: string) => key) as unknown as typeof t;

/** Phase 2 slice 63: the pure parts of the death record screens (SAFE-014; HZ-013). */

const ID = "0199f000-0000-7000-8000-0000000000d1";
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
const step = (s: DeathView["steps"][number]["step"]): DeathView["steps"][number] => ({
  step: s,
  state: "outstanding",
  at: null,
  notificationId: null,
  notificationStatus: null,
  reason: null,
});

describe("the death record screens", () => {
  it("are read with safety.incident.read and managed with safety.incident.manage", () => {
    expect(deathsShown(["safety.incident.read"])).toBe(true);
    expect(deathsShown(["care.plan.read"])).toBe(false);
    expect(canManageDeaths(["safety.incident.manage"])).toBe(true);
    expect(canManageDeaths(["safety.incident.read"])).toBe(false);
  });

  it.each(NOTIFICATION_STEPS)(
    "never record %s here: it is done in the notification centre",
    (s) => {
      expect(recordableHere(s)).toBe(false);
      expect(isNotificationStep(s)).toBe(true);
      const read = readDeathStep(
        form({ outcome: "done", ...when("at", ["31", "10", "2026", "10", "00"]) }),
        t,
        { id: ID, step: s, now: NOW },
      );
      expect(read.ok).toBe(false);
    },
  );

  it.each([
    ["verification_of_death", true],
    ["family_informed", true],
    ["police_informed", true],
    ["preserve_room_and_equipment", true],
    ["mortality_review", false],
  ] as const)("records %s here: %s", (s, here) => {
    expect(recordableHere(s)).toBe(here);
  });

  it("keeps the police steps listed while the judgement is missing", () => {
    const view = { steps: [step("verification_of_death")], missingFacts: ["expected" as const] };
    const shown = stepsToShow(view).map((s) => s.step);
    for (const police of POLICE_STEPS) expect(shown).toContain(police);
    // Once judged, only what the API sends is listed.
    expect(stepsToShow({ ...view, missingFacts: [] }).map((s) => s.step)).toEqual([
      "verification_of_death",
    ]);
    // Never listed twice.
    const both = stepsToShow({
      steps: [step("police_informed")],
      missingFacts: ["possiblyUnnatural"],
    });
    expect(both.filter((s) => s.step === "police_informed")).toHaveLength(1);
  });

  it.each([
    ["open", "due", "clock"],
    ["closed", "neutral", "circle-check"],
    ["withdrawn", "neutral", "circle-minus"],
    ["lost", "overdue", "triangle-alert"],
  ])("shows status %s as an icon and a word", (status, chip, icon) => {
    expect(deathStatusChip(status, t)).toMatchObject({ status: chip, icon });
  });

  it.each([
    ["done", "neutral", "circle-check"],
    ["not_needed", "neutral", "circle-minus"],
    ["waiting", "info", "clock"],
    ["outstanding", "due", "circle-alert"],
    ["odd", "overdue", "triangle-alert"],
  ])("shows step state %s as an icon and a word", (state, chip, icon) => {
    expect(deathStepChip(state, t)).toMatchObject({ status: chip, icon });
  });

  it("shows the mortality review as done, due or overdue", () => {
    expect(reviewChip({ reviewedAt: NOW.toISOString(), overdue: true }, t).status).toBe("neutral");
    expect(reviewChip({ reviewedAt: null, overdue: true }, t).status).toBe("overdue");
    expect(reviewChip({ reviewedAt: null, overdue: false }, t).status).toBe("due");
  });

  it("needs every part of the clinician's judgement", () => {
    expect(readJudgement(form({}), t, { version: 2 }).ok).toBe(false);
    const read = readJudgement(
      form({ expected: "no", possiblyUnnatural: "yes", judgedBy: "Dr Ada Example, GP" }),
      t,
      { version: 2 },
    );
    expect(read).toEqual({
      ok: true,
      body: {
        expected: false,
        possiblyUnnatural: true,
        judgedBy: "Dr Ada Example, GP",
        version: 2,
      },
    });
  });

  it("records a step as done, and as not needed only with a reason", () => {
    const at = when("at", ["31", "10", "2026", "10", "00"]);
    const done = readDeathStep(form({ outcome: "done", reference: "CAD 123", ...at }), t, {
      id: ID,
      step: "police_informed",
      now: NOW,
    });
    expect(done).toMatchObject({
      ok: true,
      body: { id: ID, outcome: "done", reference: "CAD 123" },
    });
    const noReason = readDeathStep(form({ outcome: "not_needed", ...at }), t, {
      id: ID,
      step: "family_informed",
      now: NOW,
    });
    expect(noReason.ok).toBe(false);
    const missingTime = readDeathStep(form({ outcome: "done" }), t, {
      id: ID,
      step: "family_informed",
      now: NOW,
    });
    expect(missingTime.ok).toBe(false);
  });

  it("needs both findings and lessons for the mortality review", () => {
    const findings = "Seen by the GP the day before; death expected.";
    expect(readDeathReview(form({ findings }), tk, { version: 1 }).ok).toBe(false);
    // Shorter than the domain's minimum (DEATH_REASON_MIN), as the API would refuse it.
    expect(readDeathReview(form({ findings, lessons: "None new." }), tk, { version: 1 }).ok).toBe(
      false,
    );
    expect(
      readDeathReview(
        form({ findings, lessons: "None new: the end of life plan was followed." }),
        tk,
        { version: 1 },
      ).ok,
    ).toBe(true);
  });

  it("links a notification step to the notification centre, and reads the exit record id", () => {
    expect(notificationHref(ID)).toBe(`/notifications/statutory/${ID}`);
    expect(notificationHref(null)).toBeNull();
    expect(exitRecordFrom(ID)).toBe(ID);
    expect(exitRecordFrom("nope")).toBeNull();
    expect(exitRecordFrom(undefined)).toBeNull();
  });

  it.each([
    ["police told", "police_informed", ["expected"], false],
    ["room left", "preserve_room_and_equipment", ["expected", "possiblyUnnatural"], false],
    ["police told, judged", "police_informed", [], true],
    ["family told, not judged", "family_informed", ["expected"], true],
  ] as const)(
    "hazard HZ-013 not needed is offered for %s only when allowed",
    (_name, s, missing, allowed) => {
      expect(notNeededAllowed(s, missing)).toBe(allowed);
    },
  );

  it("hazard HZ-013 refuses a police step as not needed while the judgement is missing", () => {
    const at = when("at", ["31", "10", "2026", "10", "00"]);
    const reason = "The GP expected it and the family agree.";
    const refused = readDeathStep(form({ outcome: "not_needed", note: reason, ...at }), tk, {
      id: ID,
      step: "police_informed",
      now: NOW,
      missingFacts: ["expected", "possiblyUnnatural"],
    });
    expect(refused).toMatchObject({
      ok: false,
      errors: { outcome: "deaths.step.policeNotNeededRefused" },
    });
    const judged = readDeathStep(form({ outcome: "not_needed", note: reason, ...at }), tk, {
      id: ID,
      step: "police_informed",
      now: NOW,
      missingFacts: [],
    });
    expect(judged.ok).toBe(true);
    const short = readDeathStep(form({ outcome: "not_needed", note: "No family.", ...at }), tk, {
      id: ID,
      step: "family_informed",
      now: NOW,
    });
    expect(short).toMatchObject({ ok: false, errors: { note: "deaths.step.reasonError" } });
  });
});
