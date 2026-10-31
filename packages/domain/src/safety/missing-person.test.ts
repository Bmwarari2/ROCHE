import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { type MissingEpisode, type MissingEvent, missingPersonState } from "./missing-person";
import { resolveSafetyPhase2Rates } from "./phase2-rates";

const rates = resolveSafetyPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 31, 14, 0) + minutes * 60_000);
const police = rates.missingPersonPoliceCallMinutes;
const episode = (events: MissingEvent[], extra: Partial<MissingEpisode> = {}): MissingEpisode => ({
  events,
  underDolsOrMha: false,
  immediateRisk: false,
  herbertProfileReviewedOn: new Date("2026-09-01T00:00:00Z"),
  ...extra,
});

describe("hazard HZ-013 missing person (safety.md Phase 2 rule 5)", () => {
  it("sets the police call target from when the person was noticed missing", () => {
    const state = missingPersonState(
      episode([{ kind: "noticed_missing", at: at(0) }]),
      at(1),
      rates,
    );
    expect(state.policeCallDueAt).toEqual(at(police));
    expect(state.policeCallLate).toBe(false);
  });

  it("says the call is late once the target passes without one, and when it was made late", () => {
    expect(
      missingPersonState(episode([{ kind: "noticed_missing", at: at(0) }]), at(police + 1), rates)
        .policeCallLate,
    ).toBe(true);
    const lateCall = missingPersonState(
      episode([
        { kind: "noticed_missing", at: at(0) },
        { kind: "police_called", at: at(police + 5), reference: "P1" },
      ]),
      at(police + 10),
      rates,
    );
    expect(lateCall).toMatchObject({ policeCallDueAt: null, policeCallLate: true });
  });

  it("needs the police reference, and events in order", () => {
    const state = missingPersonState(
      episode([
        { kind: "noticed_missing", at: at(10) },
        { kind: "last_seen", at: at(20) },
        { kind: "police_called", at: at(15) },
      ]),
      at(30),
      rates,
    );
    expect(state.problems).toContain("Record the police reference.");
    expect(state.problems.some((p) => p.includes("before"))).toBe(true);
  });

  it("allows the police to be called before the search starts", () => {
    const state = missingPersonState(
      episode([
        { kind: "noticed_missing", at: at(0) },
        { kind: "search_started", at: at(5) },
        { kind: "police_called", at: at(2), reference: "P1" },
      ]),
      at(10),
      rates,
    );
    expect(state.problems.some((p) => p.includes("before"))).toBe(false);
  });

  it("closes only after the welfare check and the debrief", () => {
    const found: MissingEvent[] = [
      { kind: "noticed_missing", at: at(0) },
      { kind: "police_called", at: at(5), reference: "P1" },
      { kind: "found", at: at(60) },
    ];
    expect(missingPersonState(episode(found), at(70), rates).canClose).toBe(false);
    expect(missingPersonState(episode([]), at(70), rates).problems).toContain(
      "The person has not been found yet.",
    );
    const done = missingPersonState(
      episode([...found, { kind: "welfare_check", at: at(65) }, { kind: "debrief", at: at(120) }]),
      at(130),
      rates,
    );
    expect(done).toMatchObject({ canClose: true, problems: [] });
  });

  it("prompts a CQC notification under DoLS or the Mental Health Act", () => {
    expect(
      missingPersonState(episode([], { underDolsOrMha: true }), at(0), rates).cqcNotificationPrompt,
    ).toBe(true);
  });

  it.each([
    [null, "none"],
    [new Date("2026-09-01T00:00:00Z"), "current"],
    [new Date("2024-01-01T00:00:00Z"), "out_of_date"],
  ] as const)("Herbert Protocol profile reviewed on %s is %s", (reviewed, status) => {
    expect(
      missingPersonState(episode([], { herbertProfileReviewedOn: reviewed }), at(0), rates)
        .herbertProfile,
    ).toBe(status);
  });
});
