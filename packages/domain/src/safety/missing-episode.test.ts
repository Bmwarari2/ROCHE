import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  HERBERT_REQUIRED_MIN,
  herbertPrefill,
  herbertProfileProblems,
  herbertReviewDueOn,
  MISSING_NOTE_MIN,
  type MissingEpisodeStatus,
  missingEpisodeView,
  type TimelineEntry,
  timelineEntryProblems,
} from "./missing-episode";
import { resolveSafetyPhase2Rates } from "./phase2-rates";

const rates = resolveSafetyPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const MIN = 60_000;
const NOTICED = new Date("2026-10-31T21:00:00Z");
const NOW = new Date("2026-10-31T23:00:00Z");
const at = (minutes: number) => new Date(NOTICED.getTime() + minutes * MIN);
const note = "x".repeat(MISSING_NOTE_MIN);
const started: TimelineEntry[] = [
  { kind: "last_seen", at: at(-30) },
  { kind: "noticed_missing", at: at(0) },
  { kind: "search_started", at: at(2) },
];
const problems = (
  existing: readonly TimelineEntry[],
  entry: TimelineEntry,
  status: MissingEpisodeStatus = "open",
) => timelineEntryProblems(status, existing, entry, NOW, rates);

describe("hazard HZ-127 the missing person timeline (slice 37)", () => {
  it.each<[string, TimelineEntry, string[]]>([
    ["a search with where", { kind: "search", at: at(5), area: "The garden and car park" }, []],
    ["a search without where", { kind: "search", at: at(5) }, ["Say where was searched."]],
    [
      "the police without their reference",
      { kind: "police_called", at: at(10) },
      ["Record the police reference."],
    ],
    [
      "the police with their reference",
      { kind: "police_called", at: at(10), reference: "CAD 123" },
      [],
    ],
    [
      "found without where",
      { kind: "found", at: at(40) },
      [`Say where and how they were found, in at least ${MISSING_NOTE_MIN} characters.`],
    ],
    [
      "a welfare check before they are found",
      { kind: "welfare_check", at: at(40), note },
      ["Record that the person was found first."],
    ],
    [
      "a step recorded twice",
      { kind: "search_started", at: at(3) },
      ["That is already on the timeline: add a note instead."],
    ],
    [
      "a time in the future",
      { kind: "search", at: new Date(NOW.getTime() + MIN), area: "The lane" },
      ["The time cannot be in the future."],
    ],
    [
      "found before the search started",
      { kind: "found", at: at(-5), note: "In the next street." },
      ['The time for "found" is before "search started".'],
    ],
  ])("hazard HZ-127 %s", (_name, entry, expected) => {
    expect(problems(started, entry)).toEqual(expected);
  });

  it("hazard HZ-127 once found: no more searching, and the welfare check and debrief follow", () => {
    const found = [...started, { kind: "found" as const, at: at(40), note: "In the next street." }];
    expect(problems(found, { kind: "search", at: at(41), area: "The park" })).toEqual([
      "The person has been found: add a note instead.",
    ]);
    expect(
      problems(found, { kind: "welfare_check", at: at(45), note: "Cold, no injuries." }),
    ).toEqual([]);
    expect(problems(found, { kind: "welfare_check", at: at(45), note: "Fine." })).toEqual([
      `Say what the welfare check found, in at least ${MISSING_NOTE_MIN} characters.`,
    ]);
    expect(problems(found, { kind: "note", at: at(46), note }, "closed")).toEqual([
      "This episode is closed and cannot change.",
    ]);
  });

  it("hazard HZ-127 says when the police call is due, and late once it passes", () => {
    const view = (timeline: readonly TimelineEntry[], immediateRisk = false, now = NOW) =>
      missingEpisodeView({
        status: "open",
        timeline,
        underDolsOrMha: false,
        immediateRisk,
        herbertProfileReviewedOn: null,
        now,
        rates,
      });
    expect(view(started, false, at(1)).policeCallDueAt).toEqual(
      at(rates.missingPersonPoliceCallMinutes),
    );
    expect(view(started, false, at(1)).policeCallLate).toBe(false);
    expect(view(started).policeCallLate).toBe(true);
    // At once when the tenant's risk assessment says so.
    expect(view(started, true, at(1)).policeCallDueAt).toEqual(at(0));
    expect(view(started, true, at(1)).policeCallLate).toBe(true);
    // Called in time: neither due nor late, and the reference is shown.
    const called = view([...started, { kind: "police_called", at: at(5), reference: "CAD 123" }]);
    expect(called).toMatchObject({
      policeCallDueAt: null,
      policeCallLate: false,
      policeReference: "CAD 123",
    });
    // Police involved: CQC is prompted (regulation 18(2)(f)).
    expect(called.cqcNotificationPrompt).toBe(true);
  });

  it("hazard HZ-127 closes only once found, with the welfare check and the debrief", () => {
    const view = (timeline: readonly TimelineEntry[]) =>
      missingEpisodeView({
        status: "found",
        timeline,
        underDolsOrMha: false,
        immediateRisk: false,
        herbertProfileReviewedOn: null,
        now: NOW,
        rates,
      });
    const found = [...started, { kind: "found" as const, at: at(20), note: "In the next street." }];
    expect(view(found).closeProblems).toEqual([
      "Check the person's welfare on return.",
      "Hold the debrief.",
    ]);
    const all = [
      ...found,
      { kind: "welfare_check" as const, at: at(25), note: "Cold, no injuries." },
      { kind: "debrief" as const, at: at(60), note: "The side gate is now locked." },
    ];
    expect(view(all)).toMatchObject({ closeProblems: [], canClose: true });
    expect(view(all.filter((e) => e.kind !== "noticed_missing")).closeProblems).toContain(
      "Record when the person was noticed missing.",
    );
  });
});

describe("hazard HZ-127 the Herbert Protocol profile (slice 37)", () => {
  const blank = {
    physicalDescription: null,
    distinguishingFeatures: null,
    usualClothing: null,
    medicalNeeds: null,
    mobility: null,
    communication: null,
    placesLikely: null,
    peopleLikely: null,
    routines: null,
    phoneOrTracker: null,
    previousEpisodes: null,
    approach: null,
  };

  it("hazard HZ-127 needs what the person looks like and where they may go, and no future review date", () => {
    expect(herbertProfileProblems({ ...blank, reviewedOn: "2026-10-31" }, "2026-10-31")).toEqual([
      `Describe what the person looks like (height, build, hair, eyes), in at least ${HERBERT_REQUIRED_MIN} characters.`,
      `Say where the person may go (earlier homes, work, places they love), in at least ${HERBERT_REQUIRED_MIN} characters.`,
    ]);
    const written = {
      ...blank,
      physicalDescription: "Tall, slim, white hair, blue eyes",
      placesLikely: "Her old home on Example Street",
    };
    expect(herbertProfileProblems({ ...written, reviewedOn: "2026-10-31" }, "2026-10-31")).toEqual(
      [],
    );
    expect(herbertProfileProblems({ ...written, reviewedOn: "2026-11-01" }, "2026-10-31")).toEqual([
      "The review date cannot be in the future.",
    ]);
  });

  it("hazard HZ-127 is out of date the configured months after its review, as the slice 7 rule reads it", () => {
    const months = rates.herbertProtocolReviewMonths;
    const due = herbertReviewDueOn("2026-08-31", months);
    const view = (now: Date, reviewed: string) =>
      missingEpisodeView({
        status: "open",
        timeline: started,
        underDolsOrMha: false,
        immediateRisk: false,
        herbertProfileReviewedOn: new Date(`${reviewed}T00:00:00Z`),
        now,
        rates,
      }).herbertProfile;
    // The day before it is due, current; after the due day begins, out of date.
    const dueAt = new Date(`${due}T00:00:00Z`);
    expect(view(new Date(dueAt.getTime() - MIN), "2026-08-31")).toBe("current");
    expect(view(new Date(dueAt.getTime() + MIN), "2026-08-31")).toBe("out_of_date");
    // A short month: the last day of it.
    expect(herbertReviewDueOn("2026-08-31", 6)).toBe("2027-02-28");
    expect(herbertReviewDueOn("2027-08-31", 6)).toBe("2028-02-29");
    expect(herbertReviewDueOn("2026-03-15", 6)).toBe("2026-09-15");
  });

  it("hazard HZ-127 prefills from the record, saying where each part came from, never the description", () => {
    const prefill = herbertPrefill({
      addressLines: ["1 Example Street", "Exampletown"],
      communicationNeeds: ["Large print"],
      firstLanguage: "Welsh",
      interpreterRequired: false,
      aboutMe: {
        howICommunicate: "Speak slowly, face me.",
        peopleWhoAreImportant: "My daughter in Exampletown.",
        pleaseDoAndDoNot: "Please do not rush me.",
        howAndWhenToSupportMe: "I walk to the shop each morning.",
      },
      allergies: ["Penicillin"],
    });
    expect(prefill.physicalDescription).toBeNull();
    expect(prefill.placesLikely).toBe(
      "Home address before moving here (from the record): 1 Example Street, Exampletown",
    );
    expect(prefill.communication).toBe(
      "From the record: Large print\nFirst language (from the record): Welsh\nFrom About Me: Speak slowly, face me.",
    );
    expect(prefill.peopleLikely).toBe("From About Me: My daughter in Exampletown.");
    expect(prefill.routines).toBe("From About Me: I walk to the shop each morning.");
    expect(prefill.approach).toBe("From About Me: Please do not rush me.");
    expect(prefill.medicalNeeds).toBe("Allergies (from the record): Penicillin");
    // Nothing on the record, nothing prefilled.
    const empty = herbertPrefill({
      addressLines: [],
      communicationNeeds: [],
      firstLanguage: null,
      interpreterRequired: false,
      aboutMe: {},
      allergies: [],
    });
    expect(Object.values(empty).every((v) => v === null)).toBe(true);
  });
});
