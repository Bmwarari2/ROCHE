import type { CandourItem } from "@harbour/contracts";
import { type CandourState, candourStepProblems } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  byWhen,
  candourClocks,
  candourCloseFacts,
  candourDocuments,
  candourFinding,
  candourForms,
  candourManageable,
  candourShown,
  candourStateChip,
  candourStepNeeds,
  candourSteps,
  DISAGREE_REASON_MIN,
  harbourFinding,
  readAttemptForm,
  readFollowUpForm,
  readRepresentatives,
  readThresholdForm,
  readVerbalForm,
  readWrittenForm,
  thresholdDisagrees,
  toCandourRecordView,
} from "./candour";
import { knownRefusals } from "./refusals";

const t = createTranslator("en-GB");
const NOW = new Date("2026-10-31T12:00:00Z");
const MANAGER = {
  tenantUserId: "0194d000-0000-7000-8000-00000000a002",
  permissions: ["safety.incident.manage"],
};
const DOC = "0194d000-0000-7000-8000-00000000d001";
const DOC2 = "0194d000-0000-7000-8000-00000000d002";
const PERSON = "0194d000-0000-7000-8600-000000000003";

function form(entries: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    for (const v of typeof value === "string" ? [value] : value) data.append(name, v);
  }
  return data;
}

function record(overrides: Partial<CandourItem> = {}): CandourItem {
  return {
    id: "0194d000-0000-7000-8000-00000000c001",
    incidentId: "0194d000-0000-7000-8000-00000000e001",
    personId: PERSON,
    state: "threshold_assessment",
    threshold: null,
    verbal: null,
    contactAttempts: [],
    written: null,
    enquiryResultsSharedAt: null,
    correspondenceDocumentIds: [],
    outcome: null,
    clocks: {
      verbalDueAt: "2026-10-30T09:00:00Z",
      writtenTargetAt: "2026-11-14T00:00:00Z",
      writtenTargetWording: "English from the API, never shown",
      provisional: true,
      ...overrides.clocks,
    },
    version: 1,
    ...overrides,
  };
}

const notifiable = {
  notifiable: true,
  decidedAt: "2026-10-30T10:00:00Z",
  decidedBy: "A health care professional",
};
const verbalDone = {
  at: "2026-10-30T11:00:00Z",
  byRepresentatives: ["The Registered Manager"],
  inPerson: true,
  accountGiven: true,
  enquiriesAdvised: true,
  apologyGiven: true,
  writtenRecordId: DOC,
};
const writtenDone = {
  sentAt: "2026-10-31T09:00:00Z",
  documentId: DOC2,
  includesAccount: true,
  includesEnquiries: true,
  includesApology: true,
};

describe("candourStateChip", () => {
  it.each([
    ["threshold_assessment", "due", "clock", "Threshold decision needed"],
    ["verbal_due", "due", "clock", "Tell the person in person"],
    ["written_due", "due", "clock", "Written notification due"],
    ["enquiries_open", "info", "search", "Enquiries still open"],
    ["not_notifiable", "notApplicable", "circle-minus", "Not a notifiable safety incident"],
    ["no_contact", "done", "circle-check", "Finished: the person could not be told in person"],
    ["closed", "done", "circle-check", "Finished"],
    ["something_new", "overdue", "triangle-alert", "Stage not known"],
  ])(
    "hazard HZ-013 says %s in words with an icon, and an unknown stage warns",
    (state, status, icon, label) => {
      expect(candourStateChip(state, t)).toEqual({ status, icon, label });
    },
  );
});

describe("candourStepNeeds mirrors the domain's candourStepProblems (HZ-091)", () => {
  const cases: readonly [string, CandourState, CandourItem][] = [
    ["no decision", "verbal_due", record()],
    [
      "the decision says not notifiable",
      "verbal_due",
      record({ threshold: { ...notifiable, notifiable: false } }),
    ],
    [
      "nothing said in person",
      "written_due",
      record({ state: "verbal_due", threshold: notifiable }),
    ],
    [
      "told, but not in person, nobody named, nothing said and no record",
      "written_due",
      record({
        state: "verbal_due",
        threshold: notifiable,
        verbal: {
          ...verbalDone,
          inPerson: false,
          byRepresentatives: [],
          accountGiven: false,
          enquiriesAdvised: false,
          apologyGiven: false,
          writtenRecordId: null,
        },
      }),
    ],
    ["no attempts", "no_contact", record({ state: "verbal_due", threshold: notifiable })],
    [
      "no written notification",
      "enquiries_open",
      record({ state: "written_due", verbal: verbalDone }),
    ],
    [
      "a written notification missing everything",
      "closed",
      record({
        state: "written_due",
        verbal: verbalDone,
        written: {
          ...writtenDone,
          documentId: null,
          includesAccount: false,
          includesEnquiries: false,
          includesApology: false,
        },
      }),
    ],
  ];

  it.each(cases)(
    "hazard HZ-091 says every need in the catalogue's words: %s",
    (_name, to, item) => {
      const problems = candourStepProblems(to, toCandourRecordView(item));
      const needs = candourStepNeeds(to, item, t);
      expect(problems.length).toBeGreaterThan(0);
      expect(needs).toHaveLength(problems.length);
      // Each problem the API would send is recognised, so none reaches people in the API's words.
      for (const problem of problems) expect(knownRefusals(problem)).toHaveLength(1);
      for (const need of needs) expect(problems).not.toContain(need);
    },
  );

  it("hazard HZ-091 needs nothing once the regulation's steps are recorded", () => {
    const done = record({
      state: "enquiries_open",
      threshold: notifiable,
      verbal: verbalDone,
      written: writtenDone,
      enquiryResultsSharedAt: "2026-10-31T10:00:00Z",
      correspondenceDocumentIds: [DOC2],
    });
    expect(candourStepNeeds("closed", done, t)).toEqual([]);
  });
});

describe("candourSteps", () => {
  it("hazard HZ-091 offers no step before the threshold decision, then only the one it points to", () => {
    expect(candourSteps(null, MANAGER, t)).toEqual([]);
    expect(candourSteps(record(), MANAGER, t)).toEqual([]);
    const yes = candourSteps(record({ threshold: notifiable }), MANAGER, t);
    expect(yes.map((s) => s.to)).toEqual(["verbal_due"]);
    expect(yes[0]).toMatchObject({ needsReason: false, needs: [] });
    const no = candourSteps(
      record({ threshold: { ...notifiable, notifiable: false } }),
      MANAGER,
      t,
    );
    expect(no.map((s) => s.to)).toEqual(["not_notifiable"]);
    expect(no[0]?.needsReason).toBe(true);
  });

  it("hazard HZ-091 lists what is missing for each step from telling the person", () => {
    const steps = candourSteps(record({ state: "verbal_due", threshold: notifiable }), MANAGER, t);
    expect(steps.map((s) => s.to)).toEqual(["written_due", "no_contact"]);
    expect(steps[0]?.needs).toContain(t("care.refusal.candourVerbal"));
    expect(steps[1]?.needs).toEqual([t("care.refusal.candourAttempts")]);
  });

  it("offers nothing without safety.incident.manage, and nothing once finished", () => {
    const reader = { tenantUserId: MANAGER.tenantUserId, permissions: ["safety.incident.read"] };
    expect(candourSteps(record({ state: "verbal_due", threshold: notifiable }), reader, t)).toEqual(
      [],
    );
    expect(candourSteps(record({ state: "closed" }), MANAGER, t)).toEqual([]);
    expect(candourSteps(record({ state: "not_notifiable" }), MANAGER, t)).toEqual([]);
  });
});

describe("candourForms and who is offered them", () => {
  it.each([
    [null, ["threshold"]],
    ["threshold_assessment", ["threshold"]],
    ["verbal_due", ["verbal", "attempt"]],
    ["written_due", ["written", "followUp"]],
    ["enquiries_open", ["written", "followUp"]],
    // A finished record offers only reopening it, with a reason (#120 review round 3, H1).
    ["not_notifiable", ["reopen"]],
    ["no_contact", ["reopen"]],
    ["closed", []],
  ] as const)("hazard HZ-013 at %s offers %j", (state, forms) => {
    expect(candourForms(state)).toEqual(forms);
  });

  it("only to a manager, on an incident seen whole and not closed", () => {
    const manage = ["safety.incident.manage"];
    expect(candourManageable({ status: "open", restricted: false }, manage)).toBe(true);
    expect(candourManageable({ status: "under_review", restricted: false }, manage)).toBe(true);
    expect(candourManageable({ status: "closed", restricted: false }, manage)).toBe(false);
    expect(candourManageable({ status: "open", restricted: true }, manage)).toBe(false);
    expect(candourManageable({ status: "open", restricted: false }, ["safety.incident.read"])).toBe(
      false,
    );
  });

  it("shows the section with a record, or with a person we support on the incident", () => {
    const people = (kinds: readonly string[]) => kinds.map((kind) => ({ kind })) as never;
    expect(candourShown({ restricted: false, people: people(["service_user"]) }, null)).toBe(true);
    expect(candourShown({ restricted: false, people: people(["worker"]) }, null)).toBe(false);
    expect(candourShown({ restricted: false, people: people([]) }, record())).toBe(true);
    expect(candourShown({ restricted: true, people: people(["service_user"]) }, record())).toBe(
      false,
    );
  });

  it("hazard HZ-013 says whether Harbour found the duty may apply", () => {
    const view = (over: object) =>
      ({ outputs: [], notifications: [], pending: [], tasks: [], ...over }) as never;
    expect(candourFinding(null)).toBe("none");
    expect(candourFinding(view({ outputs: [{ kind: "candour" }] }))).toBe("found");
    expect(candourFinding(view({ notifications: [{ kind: "candour" }] }))).toBe("found");
    expect(candourFinding(view({ pending: [{ kind: "candour" }] }))).toBe("waiting");
    expect(candourFinding(view({ tasks: [{ task: "candour_threshold_decision" }] }))).toBe(
      "waiting",
    );
    expect(candourFinding(view({ outputs: [{ kind: "riddor_death" }] }))).toBe("none");
  });
});

describe("candourClocks (ADR-0021)", () => {
  it("hazard HZ-013 says telling the person is due as soon as reasonably practicable, from when the clock started", () => {
    const clocks = candourClocks(record({ threshold: notifiable }), NOW, t, 10);
    expect(clocks?.clocks[0]?.chip).toEqual({ status: "due", icon: "clock", label: "Due now" });
    expect(clocks?.clocks[0]?.line).toEqual({
      text: "Tell the person, with an apology, as soon as reasonably practicable: the clock started 30/10/2026 09:00",
      dateTime: "2026-10-30T09:00:00Z",
    });
  });

  it("hazard HZ-013 calls the written notification the organisation's target from the rate table, never a legal deadline", () => {
    const clocks = candourClocks(record({ threshold: notifiable }), NOW, t, 10);
    expect(clocks?.clocks[1]?.chip).toEqual({ status: "due", icon: "clock", label: "Target" });
    expect(clocks?.clocks[1]?.line.text).toBe(
      "Written notification: your organisation's target is 10 working days from the decision, by the end of 13/11/2026. This is a target, not a legal deadline: the law says as soon as reasonably practicable.",
    );
    expect(clocks?.clocks[1]?.line.text).not.toMatch(/statutory/i);
    // Without the figure the date still shows, with no number made up.
    expect(candourClocks(record(), NOW, t)?.clocks[1]?.line.text).toMatch(
      /^Written notification: your organisation's target is by the end of 13\/11\/2026\./,
    );
  });

  it("hazard HZ-013 says a target that has passed in words and an icon", () => {
    const late = candourClocks(
      record({ threshold: notifiable }),
      new Date("2026-11-20T09:00:00Z"),
      t,
      10,
    );
    expect(late?.clocks[1]?.chip).toEqual({
      status: "overdue",
      icon: "circle-alert",
      label: "Past your organisation's target",
    });
  });

  it("hazard HZ-013 says what was done, and is provisional until the decision", () => {
    const told = candourClocks(
      record({
        state: "written_due",
        threshold: notifiable,
        verbal: verbalDone,
        written: writtenDone,
        clocks: { ...record().clocks, provisional: false },
      }),
      NOW,
      t,
    );
    expect(told?.provisional).toBe(false);
    expect(told?.clocks.map((c) => c.chip.label)).toEqual([
      "Told in person",
      "Written notification sent",
    ]);
    expect(told?.clocks[0]?.line.text).toBe("Told in person 30/10/2026 11:00");
    expect(candourClocks(record(), NOW, t)?.provisional).toBe(true);
  });

  it("has no clocks once it is not notifiable, and says when the person could not be told", () => {
    expect(
      candourClocks(record({ threshold: { ...notifiable, notifiable: false } }), NOW, t),
    ).toBeNull();
    expect(candourClocks(record({ state: "not_notifiable" }), NOW, t)).toBeNull();
    const none = candourClocks(record({ state: "no_contact", threshold: notifiable }), NOW, t);
    expect(none?.clocks).toHaveLength(1);
    expect(none?.clocks[0]?.chip.label).toBe("Not told in person");
  });

  it("warns when a time cannot be read", () => {
    const bad = candourClocks(
      record({ clocks: { ...record().clocks, verbalDueAt: "not a time" } }),
      NOW,
      t,
    );
    expect(bad?.clocks[0]?.line).toEqual({ text: "Due time not known", dateTime: null });
  });
});

describe("candourDocuments", () => {
  it("offers the relevant person's available PDFs, newest first, by title and when added", () => {
    const docs = candourDocuments(
      [
        {
          id: DOC,
          title: "Letter",
          createdAt: "2026-10-30T10:00:00Z",
          status: "available",
          contentType: "application/pdf",
        },
        {
          id: DOC2,
          title: "Note of the meeting",
          createdAt: "2026-10-31T10:00:00Z",
          status: "available",
          contentType: "application/pdf",
        },
        {
          id: "0194d000-0000-7000-8000-00000000d003",
          title: "Photo",
          createdAt: "2026-10-31T11:00:00Z",
          status: "available",
          contentType: "image/png",
        },
        {
          id: "0194d000-0000-7000-8000-00000000d004",
          title: "Held",
          createdAt: "2026-10-31T11:00:00Z",
          status: "quarantined",
          contentType: "application/pdf",
        },
      ],
      t,
    );
    expect(docs).toEqual([
      { id: DOC2, label: "Note of the meeting, added 31/10/2026 10:00" },
      { id: DOC, label: "Letter, added 30/10/2026 10:00" },
    ]);
  });
});

describe("reading the candour forms (HZ-090: nothing assumed)", () => {
  const offered = [{ id: DOC, label: "Letter" }];

  it("hazard HZ-090 asks every threshold question, assuming no answer and no time", () => {
    const read = readThresholdForm(form({}), [PERSON], null, NOW, t);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(Object.keys(read.errors)).toEqual(["personId", "notifiable", "decidedAt", "decidedBy"]);
  });

  it("reads a decision made just now (the server's time) or earlier, never in the future", () => {
    const base = { personId: PERSON, notifiable: "yes", decidedBy: "A health care professional" };
    const now = readThresholdForm(
      form({ ...base, "decidedAt-mode": "now" }),
      [PERSON],
      null,
      NOW,
      t,
    );
    expect(now).toEqual({
      ok: true,
      input: {
        personId: PERSON,
        notifiable: true,
        decidedAt: null,
        decidedBy: "A health care professional",
        reason: null,
      },
    });
    const earlier = readThresholdForm(
      form({
        ...base,
        notifiable: "no",
        "decidedAt-mode": "earlier",
        "decidedAt-day": "30",
        "decidedAt-month": "10",
        "decidedAt-year": "2026",
        "decidedAt-hour": "10",
        "decidedAt-minute": "00",
      }),
      [PERSON],
      null,
      NOW,
      t,
    );
    expect(earlier).toMatchObject({
      ok: true,
      input: { notifiable: false, decidedAt: "2026-10-30T10:00:00.000Z" },
    });
    const future = readThresholdForm(
      form({
        ...base,
        "decidedAt-mode": "earlier",
        "decidedAt-day": "1",
        "decidedAt-month": "11",
        "decidedAt-year": "2026",
        "decidedAt-hour": "10",
        "decidedAt-minute": "00",
      }),
      [PERSON],
      null,
      NOW,
      t,
    );
    expect(future.ok).toBe(false);
  });

  it("keeps a recorded time only when asked to, and never a person who is not on the incident", () => {
    const kept = readThresholdForm(
      form({ personId: PERSON, notifiable: "yes", decidedBy: "GP", "decidedAt-mode": "keep" }),
      [PERSON],
      notifiable,
      NOW,
      t,
    );
    expect(kept).toMatchObject({ ok: true, input: { decidedAt: notifiable.decidedAt } });
    const stranger = readThresholdForm(
      form({ personId: DOC, notifiable: "yes", decidedBy: "GP", "decidedAt-mode": "now" }),
      [PERSON],
      null,
      NOW,
      t,
    );
    expect(stranger.ok).toBe(false);
    // With nobody we support on the incident, nobody is asked for.
    expect(
      readThresholdForm(
        form({ notifiable: "yes", decidedBy: "GP", "decidedAt-mode": "now" }),
        [],
        null,
        NOW,
        t,
      ),
    ).toMatchObject({ ok: true, input: { personId: null } });
  });

  it("reads telling the person: who, whether in person (asked), what was said and the record", () => {
    const read = readVerbalForm(
      form({
        "at-mode": "now",
        byRepresentatives: " The Registered Manager \n\n A nurse ",
        inPerson: "yes",
        accountGiven: "yes",
        apologyGiven: "yes",
        writtenRecordId: DOC,
      }),
      offered,
      null,
      NOW,
      t,
    );
    expect(read).toEqual({
      ok: true,
      input: {
        at: null,
        byRepresentatives: ["The Registered Manager", "A nurse"],
        inPerson: true,
        accountGiven: true,
        enquiriesAdvised: false,
        apologyGiven: true,
        writtenRecordId: DOC,
      },
    });
    const missing = readVerbalForm(form({}), offered, null, NOW, t);
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(Object.keys(missing.errors)).toEqual(["at", "byRepresentatives", "inPerson"]);
  });

  it("takes only a document that was offered, or the one already kept", () => {
    const other = readVerbalForm(
      form({
        "at-mode": "now",
        byRepresentatives: "A nurse",
        inPerson: "yes",
        writtenRecordId: DOC2,
      }),
      offered,
      null,
      NOW,
      t,
    );
    expect(other).toMatchObject({ ok: true, input: { writtenRecordId: null } });
    const kept = readWrittenForm(
      form({ "sentAt-mode": "keep", documentId: DOC2 }),
      offered,
      writtenDone,
      NOW,
      t,
    );
    expect(kept).toMatchObject({
      ok: true,
      input: { documentId: DOC2, sentAt: writtenDone.sentAt },
    });
  });

  it("limits who told them to 10 lines of at most 200 characters", () => {
    expect(readRepresentatives("")).toBeNull();
    expect(
      readRepresentatives(Array.from({ length: 11 }, (_, i) => `Person ${i}`).join("\n")),
    ).toBeNull();
    expect(readRepresentatives("x".repeat(201))).toBeNull();
    expect(readRepresentatives("x".repeat(200))).toHaveLength(1);
  });

  it("reads an attempt to contact them, with what happened", () => {
    expect(
      readAttemptForm(form({ "attemptAt-mode": "now", note: "Phoned twice, no answer." }), NOW, t),
    ).toEqual({
      ok: true,
      input: { at: null, note: "Phoned twice, no answer." },
    });
    const short = readAttemptForm(form({ "attemptAt-mode": "now", note: "no" }), NOW, t);
    expect(short.ok).toBe(false);
  });

  it("reads the results and correspondence, results left empty until shared", () => {
    const notYet = readFollowUpForm(
      form({ correspondence: [DOC, "not a document"] }),
      offered,
      [],
      NOW,
      t,
    );
    expect(notYet).toEqual({
      ok: true,
      input: { enquiryResultsSharedAt: null, correspondenceDocumentIds: [DOC], outcome: null },
    });
    const shared = readFollowUpForm(
      form({
        "resultsSharedAt-day": "31",
        "resultsSharedAt-month": "10",
        "resultsSharedAt-year": "2026",
        "resultsSharedAt-hour": "09",
        "resultsSharedAt-minute": "30",
        correspondence: [DOC2],
        outcome: "Results shared at a meeting.",
      }),
      offered,
      [DOC2],
      NOW,
      t,
    );
    expect(shared).toEqual({
      ok: true,
      input: {
        enquiryResultsSharedAt: "2026-10-31T09:30:00.000Z",
        correspondenceDocumentIds: [DOC2],
        outcome: "Results shared at a meeting.",
      },
    });
    const half = readFollowUpForm(form({ "resultsSharedAt-day": "31" }), offered, [], NOW, t);
    expect(half.ok).toBe(false);
  });
});

describe("review round 1 (HZ-013, HZ-091)", () => {
  it("hazard HZ-013 keeps telling the person due when it was recorded but not in person (review M2)", () => {
    const clocks = candourClocks(
      record({
        state: "verbal_due",
        threshold: notifiable,
        verbal: { ...verbalDone, inPerson: false },
      }),
      NOW,
      t,
      10,
    );
    expect(clocks?.clocks[0]?.chip).toEqual({ status: "due", icon: "clock", label: "Due now" });
    expect(clocks?.clocks[0]?.line.text).toBe(
      "Recorded 30/10/2026 11:00, not in person: regulation 20(3) needs them told in person, with an apology, as soon as reasonably practicable.",
    );
    expect(clocks?.clocks.map((c) => c.chip.label)).not.toContain("Told in person");
  });

  it("hazard HZ-013 says a target at UK midnight as the end of the day before (review L2)", () => {
    // In summer UK midnight is 23:00 UTC the day before.
    expect(byWhen("2026-07-14T23:00:00Z", t)).toBe("by the end of 14/07/2026");
    expect(byWhen("2026-11-14T00:00:00Z", t)).toBe("by the end of 13/11/2026");
    expect(byWhen("2026-11-13T15:30:00Z", t)).toBe("by 13/11/2026 15:30");
    expect(byWhen("not a time", t)).toBe("Due time not known");
  });

  it("hazard HZ-013 reads the candour facts closing needs as the API does (review H1, H2)", () => {
    const incident = {
      people: [
        { kind: "service_user", role: "affected", personId: "ada" },
        { kind: "service_user", role: "witness", personId: "cal" },
        { kind: "worker", role: "affected", personId: null },
        { kind: "service_user", role: "affected", personId: "ben" },
      ],
      classifier: {
        outputs: [],
        notifications: [
          { kind: "candour", status: "draft", noLongerIndicated: true },
          { kind: "candour", status: "not_required", noLongerIndicated: false },
        ],
      },
    } as never;
    expect(candourCloseFacts(incident, null)).toEqual({
      indicated: false,
      notifiable: null,
      personId: null,
      people: ["ada", "ben"],
    });
    const found = {
      people: [],
      classifier: { outputs: [{ kind: "candour" }], notifications: [] },
    } as never;
    expect(
      candourCloseFacts(found, { threshold: { ...notifiable, notifiable: true }, personId: "ada" }),
    ).toMatchObject({ indicated: true, notifiable: true, personId: "ada" });
  });

  it("hazard HZ-013 sets Harbour's finding beside the question until a decision is recorded (review M4)", () => {
    const view = (over: object) =>
      ({
        outputs: [],
        notifications: [],
        pending: [],
        tasks: [],
        exclusions: [],
        ...over,
      }) as never;
    expect(harbourFinding(view({ outputs: [{ kind: "candour" }] }), null)).toBe("notifiable");
    expect(harbourFinding(view({ pending: [{ kind: "candour" }] }), null)).toBe("waiting");
    expect(harbourFinding(view({ exclusions: [{ kind: "candour" }] }), null)).toBe("notNotifiable");
    expect(harbourFinding(view({}), null)).toBeNull();
    expect(
      harbourFinding(view({ outputs: [{ kind: "candour" }] }), { threshold: notifiable }),
    ).toBe(null);
  });

  it.each([
    [false, "notifiable", null, true],
    [true, "notifiable", null, false],
    [true, "notNotifiable", null, true],
    [false, "notNotifiable", null, false],
    [false, "waiting", null, false],
    [true, null, notifiable, false],
    [false, null, notifiable, true],
  ] as const)(
    "hazard HZ-091 an answer of notifiable %s against %s (decision %j) needs a reason: %s",
    (answer, finding, current, needs) => {
      expect(thresholdDisagrees(answer, finding, current)).toBe(needs);
    },
  );

  it("hazard HZ-091 asks a reason of a sentence and a tick when the decision differs from Harbour's (review M4)", () => {
    const base = {
      personId: PERSON,
      notifiable: "no",
      decidedBy: "A GP",
      "decidedAt-mode": "now",
    };
    const bare = readThresholdForm(form(base), [PERSON], null, NOW, t, "notifiable");
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(Object.keys(bare.errors)).toEqual(["reason", "confirm"]);
    const short = readThresholdForm(
      form({ ...base, reason: "x".repeat(DISAGREE_REASON_MIN - 1), confirm: "yes" }),
      [PERSON],
      null,
      NOW,
      t,
      "notifiable",
    );
    expect(short.ok).toBe(false);
    const reason = "The GP saw no harm from the double dose.";
    const read = readThresholdForm(
      form({ ...base, reason, confirm: "yes" }),
      [PERSON],
      null,
      NOW,
      t,
      "notifiable",
    );
    expect(read).toMatchObject({ ok: true, input: { notifiable: false, reason } });
    // Agreeing with Harbour needs no reason, and keeps none.
    const agrees = readThresholdForm(
      form({ ...base, notifiable: "yes", reason }),
      [PERSON],
      null,
      NOW,
      t,
      "notifiable",
    );
    expect(agrees).toMatchObject({ ok: true, input: { reason: null } });
  });

  it("hazard HZ-091 makes not notifiable strict once Harbour drafted a candour notification", () => {
    const decided = record({ threshold: { ...notifiable, notifiable: false } });
    expect(candourSteps(decided, MANAGER, t, true)[0]).toMatchObject({
      to: "not_notifiable",
      needsReason: true,
      strict: true,
    });
    expect(candourSteps(decided, MANAGER, t, false)[0]).toMatchObject({
      to: "not_notifiable",
      strict: false,
    });
  });
});
