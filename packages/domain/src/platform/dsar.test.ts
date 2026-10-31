import { describe, expect, it } from "vitest";
import {
  applyRedactions,
  bundleReadiness,
  checkItemDecision,
  checkNewDsarCase,
  dsarSubjectMap,
  erasureAssessment,
  findThirdPartyNames,
  portabilityApplies,
  STAFF_ROW_COLUMNS_NOT_COLLECTED,
} from "./dsar";
import { EXPORT_TABLES, type ExportTableDefinition } from "./export-catalogue";

/**
 * The DSAR workbench rules (platform.md, Phase 2: the DSAR workbench, rules 3 to 8; PLAT-022;
 * ADR-0090). Invented people and staff only.
 */

const table = (
  columns: Record<string, "exported" | "internal" | "secret">,
  o: Partial<ExportTableDefinition> = {},
): ExportTableDefinition => ({
  context: "care",
  description: "Test table.",
  treatment: "tenant_rows",
  retention: "care_record",
  personal: true,
  columns,
  ...o,
});

describe("PLAT-022 the subject map", () => {
  const map = dsarSubjectMap({
    "public.person": table({ id: "exported", given_name: "exported" }),
    "public.contact": table({ id: "exported", person_id: "exported" }),
    "public.tenant_user": table(
      { id: "exported", display_name: "exported" },
      { context: "platform" },
    ),
    "public.care_note": table({
      id: "exported",
      person_id: "exported",
      recorded_by: "exported",
      created_by: "exported",
    }),
    "public.letter": table({
      id: "exported",
      person_id: "exported",
      contact_id: "exported",
      sent_by: "exported",
    }),
    "public.task": table(
      { id: "exported", assignee_tenant_user_id: "exported" },
      { context: "platform" },
    ),
    "public.secret_thing": table({ id: "exported", person_id: "secret" }),
    "public.location": table({ id: "exported", name: "exported" }, { personal: false }),
    "public.rate_table": table(
      { id: "exported", person_id: "exported" },
      { treatment: "tenant_overrides_only" },
    ),
    "public.incident_answer": table({ id: "exported", incident_id: "exported" }),
  });

  it("finds a person by person_id and by their own row", () => {
    expect(map.person).toEqual([
      { table: "care_note", column: "person_id" },
      { table: "contact", column: "person_id" },
      { table: "letter", column: "person_id" },
      { table: "person", column: "id" },
    ]);
  });

  it("finds a contact by their own row and by contact_id", () => {
    expect(map.contact).toEqual([
      { table: "contact", column: "id" },
      { table: "letter", column: "contact_id" },
    ]);
  });

  it("finds staff by their own row and the columns naming what they did, not every row they created", () => {
    expect(map.staff).toEqual([
      { table: "care_note", column: "recorded_by" },
      { table: "letter", column: "sent_by" },
      { table: "task", column: "assignee_tenant_user_id" },
      { table: "tenant_user", column: "id" },
    ]);
    expect(STAFF_ROW_COLUMNS_NOT_COLLECTED).toContain("created_by");
  });

  it("never searches a secret column, a table without personal data or one not exported per tenant", () => {
    const all = [...map.person, ...map.contact, ...map.staff].map((e) => e.table);
    expect(all).not.toContain("secret_thing");
    expect(all).not.toContain("location");
    expect(all).not.toContain("rate_table");
  });

  it("reports tables with personal data and no subject column as not searched, never skipping them silently", () => {
    expect(map.notSearched).toEqual(["incident_answer", "secret_thing"]);
  });

  it("covers the real catalogue: the person, contact and staff rows, and the main care tables", () => {
    const real = dsarSubjectMap(EXPORT_TABLES);
    expect(real.person).toContainEqual({ table: "person", column: "id" });
    expect(real.person).toContainEqual({ table: "care_note", column: "person_id" });
    expect(real.contact).toContainEqual({ table: "contact", column: "id" });
    expect(real.staff).toContainEqual({ table: "tenant_user", column: "id" });
    // Every exported tenant table with personal data is either searched or reported.
    for (const [key, def] of Object.entries(EXPORT_TABLES)) {
      if (def.treatment !== "tenant_rows" || !def.personal) continue;
      const name = key.replace(/^public\./, "");
      const searched = [...real.person, ...real.contact, ...real.staff].some(
        (e) => e.table === name,
      );
      expect(searched || real.notSearched.includes(name), name).toBe(true);
    }
  });
});

describe("third-party names are highlighted, never redacted", () => {
  it("finds whole names, any case, longest first, without overlaps", () => {
    const text = "Spoke with Eve Example and eve about Kit. Steven was not there.";
    expect(findThirdPartyNames(text, ["Eve Example", "Eve", "Kit"])).toEqual([
      { name: "Eve Example", start: 11, end: 22 },
      { name: "Eve", start: 27, end: 30 },
      { name: "Kit", start: 37, end: 40 },
    ]);
  });

  it("ignores names shorter than two letters and empty text", () => {
    expect(findThirdPartyNames("A note", ["A", " "])).toEqual([]);
    expect(findThirdPartyNames("", ["Eve"])).toEqual([]);
  });
});

describe("redaction decisions are a person's, with reasons", () => {
  const fields = ["body", "category", "occurred_at"];
  it.each([
    ["disclose", { decision: "disclose" }, null],
    [
      "redact without fields",
      { decision: "redact", reason: "Third-party data" },
      "fields_required",
    ],
    [
      "redact an unknown field",
      { decision: "redact", redactedFields: ["nope"], reason: "Third-party data" },
      "unknown_field",
    ],
    [
      "redact without a reason",
      { decision: "redact", redactedFields: ["body"] },
      "reason_required",
    ],
    ["withhold without a reason", { decision: "withhold" }, "reason_required"],
    [
      "redact with fields and a reason",
      { decision: "redact", redactedFields: ["body"], reason: "Third-party data (Sch 2 para 16)" },
      null,
    ],
    [
      "withhold with a reason",
      { decision: "withhold", reason: "Serious harm test (Sch 3 para 5)" },
      null,
    ],
  ] as const)("%s", (_name, decision, problem) => {
    const result = checkItemDecision({ redactedFields: [], reason: null, ...decision }, fields);
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });
});

describe("the bundle", () => {
  it("is ready only when every item has a decision", () => {
    expect(bundleReadiness([{ decision: "disclose" }, { decision: "pending" }])).toEqual({
      ready: false,
      pending: 1,
      disclosed: 1,
      withheld: 0,
    });
    expect(bundleReadiness([{ decision: "redact" }, { decision: "withhold" }])).toEqual({
      ready: true,
      pending: 0,
      disclosed: 1,
      withheld: 1,
    });
    expect(bundleReadiness([])).toMatchObject({ ready: false });
  });

  it("shows redacted fields as redacted, leaving the rest", () => {
    expect(applyRedactions({ body: "Saw Eve", category: "visit" }, ["body"])).toEqual({
      body: "[redacted]",
      category: "visit",
    });
  });
});

describe("erasure where retention allows", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  const rule = {
    recordClass: "care_record",
    period: 8,
    unit: "years" as const,
    trigger: "care_ended" as const,
  };
  it.each([
    [
      "under a legal hold",
      { legalHold: true, triggerDate: new Date("2010-01-01T00:00:00Z") },
      "held",
    ],
    [
      "within its period",
      { legalHold: false, triggerDate: new Date("2024-01-01T00:00:00Z") },
      "retained",
    ],
    [
      "past its period",
      { legalHold: false, triggerDate: new Date("2010-01-01T00:00:00Z") },
      "erasable",
    ],
    [
      "with no trigger yet (care has not ended)",
      { legalHold: false, triggerDate: null },
      "retained",
    ],
  ] as const)("a record %s is %s", (_name, input, outcome) => {
    const [result] = erasureAssessment(
      [{ table: "care_note", recordId: "r1", rule, ...input }],
      now,
    );
    expect(result?.outcome).toBe(outcome);
  });

  it("says until when a retained record is kept", () => {
    const [result] = erasureAssessment(
      [
        {
          table: "care_note",
          recordId: "r1",
          rule,
          legalHold: false,
          triggerDate: new Date("2024-01-01T00:00:00Z"),
        },
      ],
      now,
    );
    expect(result).toMatchObject({ outcome: "retained", recordClass: "care_record" });
    expect(result?.until?.toISOString()).toBe("2032-01-01T00:00:00.000Z");
  });

  it("keeps a record whose class the organisation must set first", () => {
    const [result] = erasureAssessment(
      [
        {
          table: "letter_template",
          recordId: "r1",
          rule: { ...rule, trigger: "tenant_policy" },
          legalHold: false,
          triggerDate: null,
        },
      ],
      now,
    );
    expect(result?.outcome).toBe("retained");
  });
});

describe("portability (UK GDPR Art 20)", () => {
  it.each([
    ["staff", true],
    ["person", false],
    ["contact", false],
  ] as const)("applies to %s: %s", (kind, applies) => {
    expect(portabilityApplies(kind).applies).toBe(applies);
  });
});

describe("a new case", () => {
  const base = {
    subjectKind: "person" as const,
    subjectPersonId: "p1",
    subjectContactId: null,
    subjectStaffId: null,
    requesterKind: "subject" as const,
    authority: null,
    receivedOn: "2026-10-30",
    today: "2026-10-31",
  };
  it.each([
    ["a person's own request", {}, null],
    [
      "a representative without an authority",
      { requesterKind: "representative" },
      "authority_required",
    ],
    [
      "a representative with an LPA",
      { requesterKind: "representative", authority: "lpa_health_welfare" },
      null,
    ],
    ["a person case without the person", { subjectPersonId: null }, "subject_mismatch"],
    ["a person case naming a contact too", { subjectContactId: "c1" }, "subject_mismatch"],
    ["a contact case without the contact", { subjectKind: "contact" }, "subject_mismatch"],
    [
      "a contact case with its person and contact",
      { subjectKind: "contact", subjectContactId: "c1" },
      null,
    ],
    [
      "a staff case with a person",
      { subjectKind: "staff", subjectStaffId: "s1" },
      "subject_mismatch",
    ],
    ["a staff case", { subjectKind: "staff", subjectStaffId: "s1", subjectPersonId: null }, null],
    ["received in the future", { receivedOn: "2026-11-01" }, "received_in_future"],
    ["received on a day that does not exist", { receivedOn: "2026-02-30" }, "invalid_date"],
  ] as const)("%s", (_name, change, problem) => {
    const result = checkNewDsarCase({ ...base, ...change });
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });
});
