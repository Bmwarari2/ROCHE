import {
  ALL_CASE_OUTCOMES,
  APPEAL_OUTCOMES,
  APPLICATION_STAGES,
  CASE_CLOSING_REASONS,
  CASE_MEMBER_ROLES,
  CASE_STAGES,
  CASE_TYPES,
  CLOSING_REASONS,
  EQUALITY_QUESTIONS,
  EXIT_INTERVIEW_STATES,
  HEARING_KINDS,
  HEARING_STATES,
  INDUCTION_ITEMS,
  LEAVER_ITEMS,
  LEAVING_REASONS,
  PATHWAY_CATEGORIES,
  POSTPONEMENT_REASONS,
  PREFER_NOT_TO_SAY,
  PROBATION_OUTCOMES,
  PROBATION_REVIEW_OUTCOMES,
  REFERENCE_DECLINED_REASONS,
  REFERENCE_KINDS,
  REFERENCE_STATES,
  REFERRAL_DECISIONS,
  REFERRAL_NOT_REQUIRED_REASONS,
  SCHEDULE3_ITEMS,
  VACANCY_STATUSES,
} from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import enGB from "@harbour/i18n/messages/en-GB.json";
import { describe, expect, it } from "vitest";
import {
  CASEWORK,
  caseStageChip,
  caseworkShown,
  checklistChip,
  codeLabel,
  codeOptions,
  nameOf,
  present,
  RECRUITMENT,
  recruitmentShown,
  STAFF_FILE_MANAGE,
  STAFF_FILE_READ,
  staffShown,
  stageChip,
  standardChip,
  ukDate,
} from "./workforce";

const t = createTranslator("en-GB");
const catalogue = enGB as Record<string, string>;

/** The case timeline's event kinds (packages/db/src/schema/casework.ts, employee_case_event_kind). */
const CASE_EVENT_KINDS = [
  "opened",
  "stage_changed",
  "member_added",
  "member_removed",
  "hearing_arranged",
  "hearing_updated",
  "suspension_started",
  "suspension_reviewed",
  "suspension_ended",
  "referral_recorded",
  "safeguarding_linked",
  "appeal_grounds",
  "note",
];

describe("every code the screens show has words", () => {
  const answers = [
    ...new Set([...Object.values(EQUALITY_QUESTIONS).flat(), PREFER_NOT_TO_SAY]),
  ] as string[];
  it.each<[string, readonly string[]]>([
    ["workforce.pathway", PATHWAY_CATEGORIES],
    ["workforce.schedule3", SCHEDULE3_ITEMS],
    ["workforce.registration", ["nmc", "hcpc", "swe", "gmc"]],
    ["workforce.vacancies.status", VACANCY_STATUSES],
    ["workforce.recruitment.stage", APPLICATION_STAGES],
    ["workforce.recruitment.reason", CLOSING_REASONS],
    ["workforce.interviews.recommendation", ["proceed", "do_not_proceed"]],
    ["workforce.offers.status", ["accepted", "declined", "withdrawn"]],
    ["workforce.monitoring.question", Object.keys(EQUALITY_QUESTIONS)],
    ["workforce.monitoring.answer", answers],
    ["workforce.induction.item", INDUCTION_ITEMS.map((i) => i.kind)],
    ["workforce.induction.outcome", PROBATION_OUTCOMES],
    ["workforce.induction.reviewOutcome", PROBATION_REVIEW_OUTCOMES],
    ["workforce.leaving.reason", LEAVING_REASONS],
    ["workforce.leaving.item", LEAVER_ITEMS.map((i) => i.kind)],
    ["workforce.leaving.exit", EXIT_INTERVIEW_STATES],
    ["workforce.references.kind", REFERENCE_KINDS],
    ["workforce.references.state", REFERENCE_STATES],
    ["workforce.references.declined", REFERENCE_DECLINED_REASONS],
    ["workforce.cases.type", CASE_TYPES],
    ["workforce.cases.stage", CASE_STAGES],
    ["workforce.cases.role", CASE_MEMBER_ROLES],
    ["workforce.cases.outcome", ALL_CASE_OUTCOMES],
    ["workforce.cases.appealOutcome", APPEAL_OUTCOMES],
    ["workforce.cases.closing", CASE_CLOSING_REASONS],
    ["workforce.cases.referral", REFERRAL_DECISIONS],
    ["workforce.cases.referralBody", ["dbs", "regulator"]],
    ["workforce.cases.referralNotRequired", REFERRAL_NOT_REQUIRED_REASONS],
    ["workforce.cases.hearingKind", HEARING_KINDS],
    ["workforce.cases.hearingState", HEARING_STATES],
    ["workforce.cases.postponed", POSTPONEMENT_REASONS],
    ["workforce.cases.event", CASE_EVENT_KINDS],
  ])("%s", (prefix, codes) => {
    const missing = codes.filter((code) => !(`${prefix}.${code}` in catalogue));
    expect(missing).toEqual([]);
  });
});

describe("who is offered which screen", () => {
  it.each([
    [[RECRUITMENT], true, false, false],
    [[STAFF_FILE_READ], false, true, false],
    [[STAFF_FILE_MANAGE], false, true, false],
    [[CASEWORK], false, false, true],
    [[], false, false, false],
  ])("%j", (permissions, recruitment, staff, cases) => {
    expect(recruitmentShown(permissions)).toBe(recruitment);
    expect(staffShown(permissions)).toBe(staff);
    expect(caseworkShown(permissions)).toBe(cases);
  });

  it("never offers employee relations for staff file or recruitment alone (the silo)", () => {
    expect(caseworkShown([RECRUITMENT, STAFF_FILE_READ, STAFF_FILE_MANAGE])).toBe(false);
  });
});

describe("status as an icon and a word", () => {
  it.each([
    ["done", "done", "circle-check", "Done"],
    ["overdue", "overdue", "circle-alert", "Overdue"],
    ["not_needed", "notApplicable", "circle-minus", "Not needed"],
    ["outstanding", "due", "clock", "To do"],
  ])("checklist %s", (code, status, icon, label) => {
    expect(checklistChip(code, t)).toEqual({ status, icon, label });
  });

  it.each([
    ["competent", "done", "Competent"],
    ["knowledge_assessed", "due", "Knowledge assessed"],
    ["not_started", "neutral", "Not started"],
  ])("Care Certificate %s", (code, status, label) => {
    const chip = standardChip(code, t);
    expect(chip.status).toBe(status);
    expect(chip.label).toBe(label);
    expect(chip.icon).toBeTruthy();
  });

  it.each([
    ["accepted", "done"],
    ["rejected", "notApplicable"],
    ["withdrawn", "notApplicable"],
    ["declined", "notApplicable"],
    ["applied", "info"],
    ["offered", "info"],
  ])("application %s", (stage, status) => {
    const chip = stageChip(stage, t);
    expect(chip.status).toBe(status);
    expect(chip.label).toBe(codeLabel("workforce.recruitment.stage", stage, t));
  });

  it("a case's stage", () => {
    expect(caseStageChip("closed", t)).toMatchObject({ status: "notApplicable", label: "Closed" });
    expect(caseStageChip("hearing", t)).toMatchObject({ status: "info", label: "Hearing" });
  });
});

describe("helpers", () => {
  it("codeOptions gives each code its words", () => {
    expect(codeOptions(["grievance", "probation"], "workforce.cases.type", t)).toEqual([
      { value: "grievance", label: "Grievance" },
      { value: "probation", label: "Probation" },
    ]);
  });

  it.each([
    ["2027-03-09", "09/03/2027"],
    ["2027-03-09T10:00:00Z", "09/03/2027"],
    [null, ""],
    [undefined, ""],
    ["", ""],
  ])("ukDate(%s)", (iso, expected) => {
    expect(ukDate(iso)).toBe(expected);
  });

  it("nameOf falls back to words for someone unknown", () => {
    const staff = [{ id: "a", displayName: "Ada Example" }];
    expect(nameOf(staff, "a", t)).toBe("Ada Example");
    expect(nameOf(staff, "b", t)).toBe("Someone");
    expect(nameOf(staff, null, t)).toBe("Someone");
  });

  it("present drops the names the API could not give", () => {
    expect(present([{ id: "a" }, null, undefined, { id: "b" }])).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
    expect(present(undefined)).toEqual([]);
  });
});
