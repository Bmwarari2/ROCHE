import { describe, expect, it } from "vitest";
import {
  type BatchCandidate,
  cancelProblem,
  countsByTable,
  type ProposalPlan,
  type ProposalRow,
  planBatches,
  proposalOutcome,
  proposalPlan,
  recordKey,
} from "./retention-batches";
import {
  AS_PARENT,
  applicant,
  classes,
  col,
  entry,
  NO_SUBJECT,
  PERMANENT,
  person,
  personRecord,
  staff,
} from "./retention-registry/registry";
import { sweepModeOf } from "./retention-report";
import type { ResolvedRule, RetentionClassRow, SweepRules } from "./retention-sweep";

/*
 * Propose mode (retention sweeps plan 5.4 and 5.5, slice 6). Fixtures only: a few schedule rows
 * stand in for the seeded `retention_class` table; ids are invented.
 */
const ROWS: readonly RetentionClassRow[] = [
  ["care_record", 8, "years", "care_ended"],
  ["complaint", 10, "years", "record_closed"],
  ["applicant.unsuccessful", 6, "months", "record_closed"],
  ["cctv", 0, "months", "tenant_policy"],
].map(([recordClass, period, unit, trigger]) => ({
  tenantId: null,
  recordClass: recordClass as string,
  period: period as number,
  unit: unit as string,
  trigger: trigger as string,
}));
const rules: SweepRules = {
  rows: ROWS,
  tenant: { tenantId: "00000000-0000-4000-8000-00000000000a", staffFileOption: null },
  staffFileBirthdayAge: 75,
};
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const NOW = d("2030-06-01");
const PERSON = "00000000-0000-4000-8000-000000000001";

const row = (extra: Partial<ProposalRow> = {}): ProposalRow => ({
  id: "00000000-0000-4000-8000-0000000000aa",
  recordClass: null,
  held: false,
  openCase: false,
  subjectIds: [PERSON],
  receivingCare: false,
  careEnded: null,
  entryDate: null,
  closedAt: null,
  employmentEndedAt: null,
  dateOfBirth: null,
  createdAt: null,
  periodEndsAt: null,
  count: 1,
  ...extra,
});

const proposing = (e: Parameters<typeof proposalPlan>[0]) => {
  const plan = proposalPlan(e);
  if (plan.kind !== "propose") throw new Error(`expected a proposal plan, got ${plan.reason}`);
  return plan;
};

describe("sweepModeOf: one step at a time", () => {
  it.each([
    [false, false, "off"],
    [true, false, "report"],
    [true, true, "propose"],
    // Propose without report skips a step, so nothing runs.
    [false, true, "off"],
  ] as const)("report %s, propose %s gives %s", (report, propose, mode) => {
    expect(sweepModeOf({ report, propose })).toBe(mode);
  });
});

describe("proposalPlan", () => {
  const cases: readonly [string, Parameters<typeof proposalPlan>[0], Partial<ProposalPlan>][] = [
    [
      "proof is never proposed",
      entry("t", PERMANENT, {}, NO_SUBJECT, { method: { kind: "never" } }),
      { kind: "skip", reason: "not_decided" },
    ],
    [
      "a table the report does not evaluate is never proposed (H-1613)",
      entry("t", AS_PARENT, {}, NO_SUBJECT, { parent: { table: "p", column: "p_id" } }),
      { kind: "skip", reason: "not_decided" },
    ],
    [
      "a record about a member of staff is not proposed before slice 12 (H-1612)",
      entry("t", classes("complaint"), { closedAt: col("closed_at") }, staff("worker_id")),
      { kind: "skip", reason: "staff_subject" },
    ],
    [
      "nor one naming a member of staff as a further subject",
      entry("t", classes("complaint"), { closedAt: col("closed_at") }, person(), {
        otherSubjects: [staff("staff_id")],
      }),
      { kind: "skip", reason: "staff_subject" },
    ],
    [
      "nor one whose subject is found only through its parent",
      entry("t", classes("complaint"), { closedAt: col("closed_at") }, person(null)),
      { kind: "skip", reason: "subject_through_parent" },
    ],
  ];
  it.each(cases)("%s", (_name, e, expected) => {
    expect(proposalPlan(e)).toEqual(expected);
  });

  it("reads the subject and every person column of a record it may propose", () => {
    const plan = proposing(
      entry("complaint", classes("complaint"), { closedAt: col("closed_at") }, person(), {
        otherSubjects: [person("other_person_id")],
      }),
    );
    expect(plan.subjectKind).toBe("person");
    expect(plan.subjectColumn).toBe("person_id");
    expect(plan.personColumns).toEqual(["person_id", "other_person_id"]);
  });

  it("proposes an applicant's record, which no open case can name", () => {
    const plan = proposing(
      entry(
        "applicant",
        classes("applicant.unsuccessful"),
        { closedAt: col("closed_at") },
        applicant("id"),
      ),
    );
    expect(plan).toMatchObject({
      subjectKind: "applicant",
      subjectColumn: "id",
      personColumns: [],
    });
  });

  it("proposes a record about no one with no subject", () => {
    const plan = proposing(
      entry("t", classes("complaint"), { closedAt: col("closed_at") }, NO_SUBJECT),
    );
    expect(plan).toMatchObject({ subjectKind: "none", subjectColumn: null, personColumns: [] });
  });
});

describe("proposalOutcome", () => {
  const care = proposing(personRecord("care_note", "care_record"));
  const complaint = proposing(
    entry("complaint", classes("complaint"), { closedAt: col("closed_at") }, NO_SUBJECT),
  );
  const cctv = proposing(
    entry("cctv_clip", classes("cctv"), { createdAt: col("created_at") }, NO_SUBJECT),
  );

  const cases: readonly [
    string,
    Extract<ProposalPlan, { kind: "propose" }>,
    Partial<ProposalRow>,
    string,
  ][] = [
    ["a held record is never proposed", care, { held: true, careEnded: d("2010-01-01") }, "held"],
    [
      "an open case about the person holds it until slice 12 (H-1612)",
      care,
      { openCase: true, careEnded: d("2010-01-01") },
      "open_case",
    ],
    ["a person still receiving care is waiting", care, { receivingCare: true }, "no_trigger_yet"],
    ["a record kept to a later date is not due", care, { careEnded: d("2025-01-01") }, "retain"],
    ["an open complaint is waiting", complaint, {}, "no_trigger_yet"],
    [
      "a tenant_policy class is never proposed (H-1585)",
      cctv,
      { createdAt: d("2001-01-01") },
      "tenant_policy",
    ],
  ];
  it.each(cases)("%s", (_name, plan, extra, reason) => {
    expect(proposalOutcome("t", plan, row(extra), rules, NOW)).toEqual({ kind: "skip", reason });
  });

  it("proposes a due record with its class, rule, dates and subject", () => {
    const outcome = proposalOutcome(
      "care_note",
      care,
      row({ careEnded: d("2020-03-31") }),
      rules,
      NOW,
    );
    expect(outcome).toEqual({
      kind: "propose",
      candidate: {
        table: "care_note",
        recordId: "00000000-0000-4000-8000-0000000000aa",
        recordClass: "care_record",
        rule: expect.objectContaining({ recordClass: "care_record", period: 8, origin: "global" }),
        triggerOn: d("2020-03-31"),
        dueOn: d("2028-03-31"),
        subjectKind: "person",
        subjectIds: [PERSON],
      },
    });
  });

  it("keeps no subject id for a record about no one", () => {
    const outcome = proposalOutcome(
      "complaint",
      complaint,
      row({ closedAt: d("2015-01-01") }),
      rules,
      NOW,
    );
    if (outcome.kind !== "propose") throw new Error("expected a proposal");
    expect(outcome.candidate.subjectIds).toEqual([]);
    expect(outcome.candidate.dueOn).toEqual(d("2025-01-01"));
  });
});

describe("planBatches", () => {
  const rule = (recordClass: string): ResolvedRule => ({
    recordClass,
    requestedClass: recordClass,
    period: 1,
    unit: "years",
    trigger: "created",
    origin: "global",
  });
  const candidate = (
    recordClass: string,
    recordId: string,
    due: string,
    table = "t",
  ): BatchCandidate => ({
    table,
    recordId,
    recordClass,
    rule: rule(recordClass),
    triggerOn: null,
    dueOn: d(due),
    subjectKind: "none",
    subjectIds: [],
  });
  const none = new Set<string>();
  const all = [
    candidate("complaint", "c3", "2021-01-01"),
    candidate("care_record", "a2", "2022-01-01"),
    candidate("care_record", "a1", "2022-01-01"),
    candidate("care_record", "a0", "2023-01-01", "a_table"),
    candidate("care_record", "b0", "2020-01-01", "z_table"),
  ];

  it("makes one batch per class, oldest due first, then by table and id", () => {
    const batches = planBatches(all, { maxRecords: 10, openClasses: none, inOpenBatch: none });
    expect(batches.map((b) => [b.recordClass, b.items.map((i) => i.recordId)])).toEqual([
      ["care_record", ["b0", "a1", "a2", "a0"]],
      ["complaint", ["c3"]],
    ]);
    expect(batches[0]?.rule.recordClass).toBe("care_record");
  });

  it("holds at most the rate table's number of records, the oldest due", () => {
    const [batch] = planBatches(all, { maxRecords: 2, openClasses: none, inOpenBatch: none });
    expect(batch?.items.map((i) => i.recordId)).toEqual(["b0", "a1"]);
  });

  it("proposes nothing for a class with a proposed batch, or a record already in one", () => {
    const batches = planBatches(all, {
      maxRecords: 10,
      openClasses: new Set(["complaint"]),
      inOpenBatch: new Set([recordKey("t", "a1")]),
    });
    expect(batches.map((b) => [b.recordClass, b.items.map((i) => i.recordId)])).toEqual([
      ["care_record", ["b0", "a2", "a0"]],
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])("proposes nothing when the limit is %s", (maxRecords) => {
    expect(planBatches(all, { maxRecords, openClasses: none, inOpenBatch: none })).toEqual([]);
  });

  it("counts items per table, never naming a record", () => {
    expect(countsByTable(all)).toEqual({ t: 3, a_table: 1, z_table: 1 });
  });
});

describe("cancelProblem", () => {
  it.each([
    ["proposed", 3, 3, null],
    ["proposed", 3, 2, "version_conflict"],
    ["cancelled", 4, 4, "not_proposed"],
  ] as const)("a %s batch at version %s, expected %s: %s", (status, version, expected, problem) => {
    expect(cancelProblem({ status, version }, expected)).toBe(problem);
  });
});
