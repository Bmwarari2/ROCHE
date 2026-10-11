import { describe, expect, it } from "vitest";
import { tableSafetyRates } from "../../test/rate-table";
import { type PostFallInput, postFallChecklist } from "./post-fall";

/**
 * The post-fall checklist (safety.md rule 12). Hazard HZ-027: head injury after a fall not observed
 * or escalated. Figures come from docs/specs/rates.md (`falls.*`, to verify by the CSO).
 */

const rates = tableSafetyRates();
const FELL = new Date("2026-10-14T13:30:00Z");
const MIN = 60_000;

const checklist = (o: Partial<PostFallInput>) =>
  postFallChecklist(
    { occurredAt: FELL, headInjury: "no", anticoagulantOrAntiplatelet: "no", ...o },
    rates,
  );
const tasks = (o: Partial<PostFallInput>) => checklist(o).tasks.map((t) => t.task);

/** The number of timed observations the phases produce inside the monitoring period. */
function expectedObservationCount(): number {
  const p1 = (rates.headInjuryPhase1Hours * 60) / rates.headInjuryPhase1IntervalMinutes;
  const p2 = (rates.headInjuryPhase2Hours * 60) / rates.headInjuryPhase2IntervalMinutes;
  const rest =
    (rates.fallsMonitoringHours - rates.headInjuryPhase1Hours - rates.headInjuryPhase2Hours) * 60;
  return p1 + p2 + Math.floor(rest / rates.headInjuryPhase3IntervalMinutes);
}

describe("hazard HZ-027 head injury or anticoagulants shorten the observation schedule", () => {
  it("monitors for the configured hours after a fall with no head injury and no anticoagulants", () => {
    const result = checklist({});
    expect(result.schedule).toBe("general_monitoring");
    expect(result.observationTimes).toEqual([]);
    expect(result.monitoringUntil.getTime()).toBe(
      FELL.getTime() + rates.fallsMonitoringHours * 60 * MIN,
    );
    expect(tasks({})).toEqual([
      "post_fall_injury_check",
      "post_fall_monitoring",
      "gp_contact",
      "ng249_falls_pathway",
      "bone_health_review",
    ]);
  });

  it.each<[string, Partial<PostFallInput>]>([
    ["a head injury", { headInjury: "yes" }],
    ["anticoagulant or antiplatelet treatment", { anticoagulantOrAntiplatelet: "yes" }],
    ["a head injury that cannot be ruled out", { headInjury: "unsure" }],
    ["unanswered questions", { headInjury: null, anticoagulantOrAntiplatelet: null }],
  ])("prompts urgent medical advice and timed observations for %s", (_name, o) => {
    const result = checklist(o);
    expect(result.schedule).toBe("timed_observations");
    expect(tasks(o)).toEqual([
      "post_fall_injury_check",
      "urgent_medical_advice",
      "post_fall_observations",
      "gp_contact",
      "ng249_falls_pathway",
      "bone_health_review",
    ]);
    const advice = result.tasks.find((t) => t.task === "urgent_medical_advice");
    expect(advice?.dueAt).toEqual(FELL);
    expect(advice?.reason).toMatch(/NICE NG232 1\.2\.4/);
  });

  it("times the observations from the rate table, in elapsed time", () => {
    const result = checklist({ headInjury: "yes" });
    const times = result.observationTimes.map((t) => t.getTime());
    expect(times).toHaveLength(expectedObservationCount());
    expect(times[0]).toBe(FELL.getTime() + rates.headInjuryPhase1IntervalMinutes * MIN);
    const gaps = times.slice(1).map((t, i) => (t - (times[i] as number)) / MIN);
    expect(new Set(gaps)).toEqual(
      new Set([
        rates.headInjuryPhase1IntervalMinutes,
        rates.headInjuryPhase2IntervalMinutes,
        rates.headInjuryPhase3IntervalMinutes,
      ]),
    );
    expect(Math.max(...times)).toBeLessThanOrEqual(result.monitoringUntil.getTime());
    expect(result.phases.map((p) => p.forHours)).toEqual([
      rates.headInjuryPhase1Hours,
      rates.headInjuryPhase2Hours,
      null,
    ]);
  });

  it("keeps the intervals exact across the October clock change", () => {
    const night = new Date("2026-10-24T23:30:00Z"); // 00:30 BST on Sunday 25 October
    const times = checklist({ occurredAt: night, headInjury: "yes" }).observationTimes;
    expect((times[3] as Date).getTime() - night.getTime()).toBe(
      rates.headInjuryPhase1Hours * 60 * MIN,
    );
  });

  it("counts from when the person was found", () => {
    const foundAt = new Date(FELL.getTime() + 45 * MIN);
    const result = checklist({ headInjury: "yes", foundAt });
    expect(result.observationTimes[0]?.getTime()).toBe(
      foundAt.getTime() + rates.headInjuryPhase1IntervalMinutes * MIN,
    );
    expect(result.tasks[0]?.dueAt).toEqual(foundAt);
  });

  it("produces no score of any kind (medical-device boundary)", () => {
    const result = checklist({ headInjury: "yes" });
    expect(Object.keys(result)).not.toContain("score");
    expect(result.tasks.every((t) => t.sources.length > 0)).toBe(true);
    expect(result.tasks.filter((t) => t.dueAt === null).map((t) => t.task)).toEqual([
      "gp_contact",
      "ng249_falls_pathway",
      "bone_health_review",
    ]);
  });
});
