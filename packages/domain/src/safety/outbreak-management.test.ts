import { describe, expect, it } from "vitest";
import {
  casesStillUnwell,
  checkIpcTemplate,
  checkOutbreakCase,
  checkOutbreakClosure,
  currentCases,
  IPC_CODE_CRITERIA,
  type IpcAuditQuestion,
  ipcCriteriaResults,
  type OutbreakCase,
  ukhsaReportFields,
} from "./outbreak-management";

const TODAY = "2026-10-31";

const base: OutbreakCase = {
  id: "c1",
  caseType: "resident",
  personId: "p1",
  tenantUserId: null,
  onsetOn: "2026-10-28",
  symptoms: ["cough", "fever"],
  testType: "pcr",
  testedOn: "2026-10-29",
  testResult: "positive",
  fluVaccinated: "yes",
  covidVaccinated: "yes",
  outcome: "unwell",
  outcomeOn: null,
  supersedesId: null,
  createdAt: "2026-10-29T10:00:00Z",
};
const kase = (over: Partial<OutbreakCase>): OutbreakCase => ({ ...base, ...over });
const open = { state: "declared" as const };

describe("checkOutbreakCase: what goes on the line list", () => {
  it.each<[string, Partial<OutbreakCase>, { state: "declared" | "closed" }, string[]]>([
    ["a complete resident case", {}, open, []],
    [
      "a staff case naming the member of staff",
      { caseType: "staff", personId: null, tenantUserId: "u1" },
      open,
      [],
    ],
    ["an untested case", { testType: null, testedOn: null, testResult: "not_tested" }, open, []],
    ["a recovered case with its date", { outcome: "recovered", outcomeOn: "2026-10-30" }, open, []],
    ["a case on a closed outbreak", {}, { state: "closed" }, ["outbreak_closed"]],
    ["a resident case without the person", { personId: null }, open, ["subject_mismatch"]],
    [
      "a staff case naming a resident",
      { caseType: "staff", tenantUserId: "u1" },
      open,
      ["subject_mismatch"],
    ],
    ["no symptoms", { symptoms: [] }, open, ["no_symptoms"]],
    [
      "symptoms starting tomorrow",
      { onsetOn: "2026-11-01", testedOn: null, testType: null, testResult: "not_tested" },
      open,
      ["onset_in_future"],
    ],
    ["a result without the test", { testType: null }, open, ["test_incomplete"]],
    [
      "a test said not to be taken but dated",
      { testResult: "not_tested" },
      open,
      ["test_incomplete"],
    ],
    ["a test before symptoms", { testedOn: "2026-10-27" }, open, ["tested_before_onset"]],
    ["a test dated tomorrow", { testedOn: "2026-11-01" }, open, ["tested_in_future"]],
    ["an outcome without its date", { outcome: "hospitalised" }, open, ["outcome_date_missing"]],
    [
      "an outcome before symptoms",
      { outcome: "recovered", outcomeOn: "2026-10-27" },
      open,
      ["outcome_date_before_onset"],
    ],
    [
      "an outcome dated tomorrow",
      { outcome: "died", outcomeOn: "2026-11-01" },
      open,
      ["outcome_date_in_future"],
    ],
  ])("%s", (_label, over, outbreak, expected) => {
    expect(checkOutbreakCase(kase(over), outbreak, TODAY)).toEqual(expected);
  });
});

describe("currentCases", () => {
  it("keeps each subject's latest entry", () => {
    const first = kase({ id: "a" });
    const update = kase({
      id: "b",
      supersedesId: "a",
      outcome: "recovered",
      outcomeOn: "2026-10-30",
    });
    const other = kase({ id: "c", personId: "p2" });
    expect(currentCases([first, update, other]).map((c) => c.id)).toEqual(["b", "c"]);
  });
});

describe("ukhsaReportFields: the report from the line list", () => {
  const location: { name: string; postcode: string | null; cqcLocationId: string | null } = {
    name: "Example House",
    postcode: "ZZ99 9ZZ",
    cqcLocationId: "1-000000001",
  };
  const outbreak = {
    syndrome: "acute_respiratory" as const,
    organism: null,
    declaredOn: "2026-10-29",
  };

  it("counts residents, staff, onsets, tests, outcomes and vaccination from current cases", () => {
    const report = ukhsaReportFields(outbreak, location, [
      kase({ id: "a", onsetOn: "2026-10-27", testedOn: "2026-10-28" }),
      kase({
        id: "a2",
        supersedesId: "a",
        onsetOn: "2026-10-27",
        testedOn: "2026-10-28",
        outcome: "hospitalised",
        outcomeOn: "2026-10-29",
      }),
      kase({ id: "b", personId: "p2", testResult: "negative", fluVaccinated: "no" }),
      kase({
        id: "c",
        caseType: "staff",
        personId: null,
        tenantUserId: "u1",
        onsetOn: "2026-10-30",
        testType: null,
        testedOn: null,
        testResult: "not_tested",
      }),
    ]);
    expect(report).toMatchObject({
      residentCases: 2,
      staffCases: 1,
      firstOnsetOn: "2026-10-27",
      latestOnsetOn: "2026-10-30",
      tested: 2,
      positive: 1,
      pending: 0,
      hospitalised: 1,
      died: 0,
      fluVaccination: { yes: 2, no: 1, unknown: 0 },
      covidVaccination: { yes: 3, no: 0, unknown: 0 },
      missing: [],
    });
    expect(report.source.url).toMatch(/^https:\/\/www\.gov\.uk\//);
  });

  it.each<[string, Partial<typeof location>, OutbreakCase[], string]>([
    ["no postcode", { postcode: null }, [base], "postcode"],
    ["no CQC location ID", { cqcLocationId: null }, [base], "CQC location ID"],
    ["no cases", {}, [], "At least one case"],
    ["vaccination not known", {}, [kase({ covidVaccinated: "unknown" })], "Vaccination"],
    ["a pending test", {}, [kase({ testResult: "pending" })], "pending tests"],
  ])("lists what is missing, never guessing it: %s", (_label, over, cases, missing) => {
    const report = ukhsaReportFields(outbreak, { ...location, ...over }, cases);
    expect(report.missing.join(" ")).toContain(missing);
  });
});

describe("hazard HZ-013 checkOutbreakClosure: closing never hides a report still due", () => {
  it.each<
    [
      string,
      "declared" | "closed",
      "draft" | "ready" | "submitted" | "not_required" | null,
      string | null,
      string,
      string[],
    ]
  >([
    ["report submitted", "declared", "submitted", "2026-10-20", "2026-10-31", []],
    ["report recorded as not needed", "declared", "not_required", "2026-10-20", "2026-10-31", []],
    ["no report drafted", "declared", null, null, "2026-10-31", []],
    ["report still a draft", "declared", "draft", "2026-10-20", "2026-10-31", ["report_undecided"]],
    [
      "report ready but not sent",
      "declared",
      "ready",
      "2026-10-20",
      "2026-10-31",
      ["report_undecided"],
    ],
    ["already closed", "closed", "submitted", null, "2026-10-31", ["already_closed"]],
    [
      "before the last onset",
      "declared",
      "submitted",
      "2026-10-25",
      "2026-10-24",
      ["closed_before_last_onset"],
    ],
    ["in the future", "declared", "submitted", null, "2026-11-01", ["closed_in_future"]],
  ])("%s", (_label, state, status, latest, closedOn, expected) => {
    expect(
      checkOutbreakClosure({ state }, status === null ? null : { status }, latest, closedOn, TODAY),
    ).toEqual(expected);
  });

  it("counts cases still unwell, to say beside the closure", () => {
    expect(
      casesStillUnwell([base, kase({ id: "x", outcome: "recovered", outcomeOn: "2026-10-30" })]),
    ).toBe(1);
  });
});

describe("IPC audits against the Code of Practice criteria", () => {
  const q = (key: string, ipcCriteria: string[], weight = 1): IpcAuditQuestion => ({
    key,
    text: `Question ${key}`,
    weight,
    statementIds: [],
    actionRequired: true,
    ipcCriteria,
  });

  it("has the ten criteria, numbered 1 to 10", () => {
    expect(IPC_CODE_CRITERIA.map((c) => c.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `criterion_${i + 1}`),
    );
  });

  it.each<[string, IpcAuditQuestion[], string[]]>([
    [
      "every question mapped",
      [q("a", ["criterion_1"]), q("b", ["criterion_2", "criterion_9"])],
      [],
    ],
    ["an unknown criterion", [q("a", ["criterion_11"])], ["unknown_criterion"]],
    ["an unmapped question", [q("a", [])], ["question_unmapped"]],
  ])("checkIpcTemplate: %s", (_label, questions, expected) => {
    expect(checkIpcTemplate(questions)).toEqual(expected);
  });

  it("scores each criterion with the audit's own method and leaves uncovered ones unscored", () => {
    const questions = [
      q("a", ["criterion_2"], 2),
      q("b", ["criterion_2", "criterion_9"]),
      q("c", ["criterion_9"]),
    ];
    const results = ipcCriteriaResults(questions, { a: "yes", b: "partial", c: "not_applicable" });
    const two = results.find((r) => r.criterion.id === "criterion_2");
    const nine = results.find((r) => r.criterion.id === "criterion_9");
    const seven = results.find((r) => r.criterion.id === "criterion_7");
    expect(two).toMatchObject({ achieved: 2.5, possible: 3, fellShort: ["b"] });
    expect(two?.percent).toBeCloseTo(83.333, 3);
    expect(nine).toMatchObject({
      achieved: 0.5,
      possible: 1,
      percent: 50,
      questionKeys: ["b", "c"],
    });
    expect(seven).toMatchObject({ percent: null, questionKeys: [] });
  });
});
