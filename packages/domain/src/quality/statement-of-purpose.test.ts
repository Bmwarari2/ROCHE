import { describe, expect, it } from "vitest";
import { readRateTable, tableStatementOfPurposeRates } from "../../test/rate-table";
import { RateNotFoundError } from "../platform/rates";
import { builtinRole } from "../platform/roles";
import { checkWorkflowTransition } from "../platform/workflow";
import { citationText } from "../shared/citation";
import { addUkDays } from "../shared/time";
import { resolveStatementOfPurposeRates } from "./rates";
import {
  checkStatementOfPurpose,
  checkStatementOfPurposeApproval,
  checkStatementOfPurposeNotificationRecord,
  STATEMENT_OF_PURPOSE_APPROVAL_MESSAGES,
  STATEMENT_OF_PURPOSE_ITEMS,
  STATEMENT_OF_PURPOSE_MESSAGES,
  STATEMENT_OF_PURPOSE_NOTIFICATION_MESSAGES,
  STATEMENT_OF_PURPOSE_WORKFLOW,
  type StatementOfPurposeContent,
  type StatementOfPurposeVersion,
  startStatementOfPurposeRevision,
  statementOfPurposeChanges,
  statementOfPurposeNotificationState,
  statementOfPurposeRegistrationPrompts,
} from "./statement-of-purpose";

/** Statement of purpose (quality.md section 4 rules 8 to 12). CQC Registration Regulations reg 12. */

const rates = tableStatementOfPurposeRates();
const APPROVED = new Date("2026-10-12T10:00:00Z");
const permissionsOf = (role: string) => new Set(builtinRole(role)?.permissions ?? []);

const CONTENT: StatementOfPurposeContent = {
  aimsAndObjectives: "To give people a safe, warm home where they choose how they live each day.",
  serviceKinds: ["Care home service with nursing"],
  needsMet: "Older people, people living with dementia and people with physical disabilities.",
  provider: {
    fullName: "Example Care Homes Ltd",
    businessAddress: "1 Example Street, Exampletown",
    businessPhone: "01632 960001",
    email: "office@example.invalid",
  },
  registeredManagers: [
    {
      id: "rm-1",
      fullName: "Rita Manager",
      businessAddress: "Harbour House, 2 Example Road",
      businessPhone: "01632 960002",
      email: null,
    },
  ],
  serviceAddress: "1 Example Street, Exampletown",
  consentsToEmailService: true,
  serviceEmail: "notices@example.invalid",
  legalStatus: "limited_company",
  legalStatusDetail: null,
  locations: [
    {
      id: "loc-1",
      name: "Harbour House",
      address: "2 Example Road",
      cqcLocationId: "1-000000001",
    },
  ],
};

function version(o: Partial<StatementOfPurposeVersion> = {}): StatementOfPurposeVersion {
  return {
    id: "sop-2",
    version: 2,
    state: "draft",
    kind: "revision",
    content: CONTENT,
    authorId: "staff-quality-lead",
    contributorIds: ["staff-quality-lead"],
    approvedBy: null,
    approvedAt: null,
    notifiedAt: null,
    ...o,
  };
}

const current = version({
  id: "sop-1",
  version: 1,
  state: "approved",
  kind: "baseline",
  approvedBy: "staff-owner",
  approvedAt: new Date("2026-01-05T10:00:00Z"),
});

describe("statement of purpose figures come from the rate table", () => {
  it("has the regulation 12(3) notice period, verified", () => {
    const row = readRateTable().find(
      (r) => r.key === "cqc.statement_of_purpose.revision_notice_days",
    );
    expect(row?.verificationStatus).toBe("verified");
    expect(row?.source).toContain("legislation.gov.uk/uksi/2009/3112/regulation/12");
    expect(rates.revisionNoticeDays).toBe(Number(row?.value));
  });

  it("fails loudly outside England until the nation packs", () => {
    expect(() =>
      resolveStatementOfPurposeRates(readRateTable(), "wales", "2026-10-11", null),
    ).toThrow(RateNotFoundError);
  });
});

describe("who may write and approve", () => {
  it.each([
    ["owner", true, true],
    ["registered_manager", true, true],
    ["deputy_manager", true, false],
    ["quality_lead", true, false],
    ["clinical_lead", false, false],
    ["administrator", false, false],
  ] as const)("%s writes: %s, approves: %s", (role, write, approve) => {
    const permissions = permissionsOf(role);
    expect(permissions.has("quality.statement_of_purpose.write")).toBe(write);
    expect(permissions.has("quality.statement_of_purpose.approve")).toBe(approve);
  });
});

describe("the Schedule 3 checklist", () => {
  it("lists the five paragraphs of Schedule 3 with their citations", () => {
    expect(STATEMENT_OF_PURPOSE_ITEMS.map((i) => citationText(i.citation))).toEqual([
      "CQC (Registration) Regulations 2009 Schedule 3 para 1",
      "CQC (Registration) Regulations 2009 Schedule 3 para 2",
      "CQC (Registration) Regulations 2009 Schedule 3 para 3 (substituted by S.I. 2012/921)",
      "CQC (Registration) Regulations 2009 Schedule 3 para 4",
      "CQC (Registration) Regulations 2009 Schedule 3 para 5",
    ]);
  });

  it("accepts a complete statement", () => {
    const checklist = checkStatementOfPurpose(CONTENT);
    expect(checklist.complete).toBe(true);
    expect(checklist.items.every((i) => i.complete)).toBe(true);
    expect(checklist.warnings).toEqual([]);
  });

  const manager = CONTENT.registeredManagers[0];
  const location = CONTENT.locations[0];
  if (!manager || !location) throw new Error("fixture");

  it.each<[string, Partial<StatementOfPurposeContent>, string, string[]]>([
    ["no aims", { aimsAndObjectives: "Care" }, "aims_and_objectives", ["aims_missing"]],
    [
      "no kinds of service",
      { serviceKinds: [" "] },
      "services_and_needs",
      ["service_kinds_missing"],
    ],
    ["no range of needs", { needsMet: "" }, "services_and_needs", ["needs_missing"]],
    [
      "a provider with no name, address or phone",
      { provider: { fullName: "", businessAddress: " ", businessPhone: "", email: null } },
      "contact_details",
      ["provider_name_missing", "provider_address_missing", "provider_phone_missing"],
    ],
    [
      "a registered manager with no phone",
      { registeredManagers: [{ ...manager, businessPhone: "" }] },
      "contact_details",
      ["manager_details_missing"],
    ],
    [
      "no address for CQC notices",
      { serviceAddress: "" },
      "contact_details",
      ["service_address_missing"],
    ],
    [
      "consent to email notices with no email",
      { serviceEmail: null },
      "contact_details",
      ["service_email_missing"],
    ],
    ["no legal status", { legalStatus: null }, "legal_status", ["legal_status_missing"]],
    [
      "an 'other' legal status with no detail",
      { legalStatus: "other", legalStatusDetail: " " },
      "legal_status",
      ["legal_status_missing"],
    ],
    ["no locations", { locations: [] }, "locations", ["locations_missing"]],
    [
      "a location with no address",
      { locations: [{ ...location, address: "" }] },
      "locations",
      ["location_details_missing"],
    ],
  ])("flags %s", (_label, o, key, problems) => {
    const checklist = checkStatementOfPurpose({ ...CONTENT, ...o });
    expect(checklist.complete).toBe(false);
    expect(checklist.items.find((i) => i.key === key)?.problems).toEqual(problems);
  });

  it("accepts no email for notices when the provider has not agreed to email", () => {
    expect(
      checkStatementOfPurpose({ ...CONTENT, consentsToEmailService: false, serviceEmail: null })
        .complete,
    ).toBe(true);
    expect(
      checkStatementOfPurpose({ ...CONTENT, legalStatus: "other", legalStatusDetail: "Trust" })
        .complete,
    ).toBe(true);
  });

  it("warns, without failing, when no registered manager is listed", () => {
    const checklist = checkStatementOfPurpose({ ...CONTENT, registeredManagers: [] });
    expect(checklist).toMatchObject({ complete: true, warnings: ["no_registered_manager"] });
  });

  it("has a message for every problem", () => {
    for (const m of Object.values(STATEMENT_OF_PURPOSE_MESSAGES)) {
      expect(m.length).toBeGreaterThan(10);
    }
  });
});

describe("section-level change summary", () => {
  const manager = CONTENT.registeredManagers[0];
  const location = CONTENT.locations[0];
  if (!manager || !location) throw new Error("fixture");
  const changed = (o: Partial<StatementOfPurposeContent>) =>
    statementOfPurposeChanges(CONTENT, { ...CONTENT, ...o })
      .filter((c) => c.change === "changed")
      .map((c) => [c.key, c.lines]);

  it("reports nothing when nothing changed", () => {
    expect(changed({})).toEqual([]);
  });

  it.each<[string, Partial<StatementOfPurposeContent>, [string, string[]][]]>([
    [
      "reworded aims",
      { aimsAndObjectives: `${CONTENT.aimsAndObjectives} Updated.` },
      [["aims_and_objectives", ["Aims and objectives reworded"]]],
    ],
    [
      "a service added and one removed, and the needs reworded",
      {
        serviceKinds: ["Care home service without nursing"],
        needsMet: "Older people only, please.",
      },
      [
        [
          "services_and_needs",
          [
            "Service added: Care home service without nursing",
            "Service removed: Care home service with nursing",
            "Range of needs met reworded",
          ],
        ],
      ],
    ],
    [
      "the provider's phone number",
      { provider: { ...CONTENT.provider, businessPhone: "01632 960009" } },
      [["contact_details", ["Provider business telephone number changed"]]],
    ],
    [
      "a new registered manager replacing the old",
      { registeredManagers: [{ ...manager, id: "rm-2", fullName: "Sam Manager" }] },
      [
        [
          "contact_details",
          ["Registered manager added: Sam Manager", "Registered manager removed: Rita Manager"],
        ],
      ],
    ],
    [
      "the registered manager's email",
      { registeredManagers: [{ ...manager, email: "rita@example.invalid" }] },
      [["contact_details", ["Registered manager changed: Rita Manager"]]],
    ],
    [
      "the address for CQC notices",
      { consentsToEmailService: false, serviceEmail: null },
      [["contact_details", ["Address for CQC notices changed"]]],
    ],
    [
      "the legal status",
      { legalStatus: "charitable_incorporated_organisation" },
      [["legal_status", ["Legal status changed"]]],
    ],
    [
      "a location renamed and one added",
      {
        locations: [
          { ...location, name: "Harbour House Nursing" },
          { id: "loc-2", name: "Harbour Lodge", address: "3 Example Road", cqcLocationId: null },
        ],
      },
      [["locations", ["Location changed: Harbour House Nursing", "Location added: Harbour Lodge"]]],
    ],
    ["a location removed", { locations: [] }, [["locations", ["Location removed: Harbour House"]]]],
  ])("summarises %s", (_label, o, expected) => {
    expect(changed(o)).toEqual(expected);
  });

  it("marks every section on the first version in Harbour", () => {
    const first = statementOfPurposeChanges(null, CONTENT);
    expect(first.every((c) => c.change === "changed")).toBe(true);
    expect(first[0]?.lines).toEqual(["First version in Harbour"]);
  });
});

describe("registration prompts (Harbour's reading, to confirm with CQC)", () => {
  const manager = CONTENT.registeredManagers[0];
  if (!manager) throw new Error("fixture");
  it.each<[string, Partial<StatementOfPurposeContent>, string[]]>([
    ["a reworded aim", { aimsAndObjectives: `${CONTENT.aimsAndObjectives} More.` }, []],
    [
      "a location added",
      {
        locations: [
          ...CONTENT.locations,
          { id: "loc-2", name: "Harbour Lodge", address: "3 Example Road", cqcLocationId: null },
        ],
      },
      ["Health and Social Care Act 2008 s.19"],
    ],
    [
      "a new registered manager",
      { registeredManagers: [{ ...manager, id: "rm-2" }] },
      ["Health and Social Care Act 2008 s.14"],
    ],
    [
      "a new legal status",
      { legalStatus: "partnership" },
      ["Health and Social Care Act 2008 s.10"],
    ],
  ])("%s", (_label, o, citations) => {
    const prompts = statementOfPurposeRegistrationPrompts(CONTENT, { ...CONTENT, ...o });
    expect(prompts.map((p) => citationText(p.citation))).toEqual(citations);
  });

  it("does not prompt for the first version", () => {
    expect(statementOfPurposeRegistrationPrompts(null, CONTENT)).toEqual([]);
  });
});

describe("approval: the author cannot approve their own change", () => {
  const draft = version({
    content: { ...CONTENT, aimsAndObjectives: `${CONTENT.aimsAndObjectives} Revised.` },
  });
  const approver = (id: string, role: string) => ({
    id,
    permissions: permissionsOf(role),
    at: APPROVED,
  });

  it("approves a revision and starts the regulation 12(3) clock", () => {
    const check = checkStatementOfPurposeApproval(
      draft,
      current,
      approver("staff-manager", "registered_manager"),
      rates,
    );
    expect(check).toMatchObject({
      ok: true,
      supersedesVersionId: "sop-1",
      notificationDueAt: addUkDays(APPROVED, rates.revisionNoticeDays),
    });
    expect(check.ok && citationText(check.citation)).toBe(
      "CQC (Registration) Regulations 2009 reg 12(3)",
    );
  });

  it("starts no clock for the baseline CQC already holds", () => {
    const check = checkStatementOfPurposeApproval(
      version({ kind: "baseline" }),
      null,
      approver("staff-owner", "owner"),
      rates,
    );
    expect(check).toMatchObject({ ok: true, notificationDueAt: null, supersedesVersionId: null });
  });

  it.each<[string, Partial<StatementOfPurposeVersion>, ReturnType<typeof approver>, string[]]>([
    [
      "the author",
      { authorId: "staff-manager", contributorIds: ["staff-manager"] },
      approver("staff-manager", "registered_manager"),
      ["author_cannot_approve"],
    ],
    [
      "someone who edited it",
      { contributorIds: ["staff-quality-lead", "staff-manager"] },
      approver("staff-manager", "registered_manager"),
      ["author_cannot_approve"],
    ],
    ["a deputy manager", {}, approver("staff-deputy", "deputy_manager"), ["missing_permission"]],
    [
      "an already approved version",
      { state: "approved" },
      approver("staff-manager", "registered_manager"),
      ["not_draft"],
    ],
    [
      "an incomplete statement",
      { content: { ...draft.content, locations: [] } },
      approver("staff-manager", "registered_manager"),
      ["incomplete"],
    ],
    [
      "a version with no changes",
      { content: CONTENT },
      approver("staff-manager", "registered_manager"),
      ["no_changes"],
    ],
  ])("refuses approval by or of %s", (_label, o, by, problems) => {
    const check = checkStatementOfPurposeApproval({ ...draft, ...o }, current, by, rates);
    expect(check.ok ? null : check.problems).toEqual(problems);
  });

  it("enforces the same rule in the workflow", () => {
    const check = checkWorkflowTransition(
      STATEMENT_OF_PURPOSE_WORKFLOW,
      { state: "draft", createdBy: "staff-manager" },
      {
        to: "approved",
        actorId: "staff-manager",
        permissions: permissionsOf("registered_manager"),
        stepUpFresh: false,
      },
    );
    expect(check).toMatchObject({ ok: false, problem: "separation_of_duties" });
  });

  it("has a message for every problem", () => {
    for (const m of Object.values(STATEMENT_OF_PURPOSE_APPROVAL_MESSAGES)) {
      expect(m.length).toBeGreaterThan(10);
    }
  });

  it("starts a revision as a new draft, leaving the approved version unchanged", () => {
    const next = startStatementOfPurposeRevision(current, "sop-3", "staff-quality-lead");
    expect(next).toMatchObject({
      id: "sop-3",
      version: 2,
      state: "draft",
      kind: "revision",
      contributorIds: ["staff-quality-lead"],
      approvedAt: null,
    });
    expect(current.state).toBe("approved");
  });
});

describe("the CQC notification of a revision", () => {
  const approvedRevision = version({ state: "approved", approvedAt: APPROVED });
  const due = addUkDays(APPROVED, rates.revisionNoticeDays);

  it.each<[string, Partial<StatementOfPurposeVersion>, Date, string]>([
    ["just approved", {}, APPROVED, "due"],
    ["on the last moment", {}, due, "due"],
    ["after the period", {}, new Date(due.getTime() + 60_000), "overdue"],
    ["a baseline", { kind: "baseline" }, APPROVED, "not_required"],
    ["not yet approved", { approvedAt: null }, APPROVED, "not_required"],
  ])("is %s", (_label, o, at, state) => {
    expect(
      statementOfPurposeNotificationState({ ...approvedRevision, ...o }, rates, at).state,
    ).toBe(state);
  });

  it("records whether the notification went late", () => {
    expect(
      statementOfPurposeNotificationState(
        { ...approvedRevision, notifiedAt: new Date(due.getTime() + 1) },
        rates,
        due,
      ),
    ).toEqual({ state: "notified", notifiedAt: new Date(due.getTime() + 1), late: true });
    expect(
      statementOfPurposeNotificationState(
        { ...approvedRevision, notifiedAt: APPROVED },
        rates,
        due,
      ),
    ).toMatchObject({ state: "notified", late: false });
  });

  const record = (
    o: Partial<Parameters<typeof checkStatementOfPurposeNotificationRecord>[1]> = {},
  ) => ({
    permissions: permissionsOf("registered_manager"),
    stepUpFresh: true,
    sentAt: new Date(APPROVED.getTime() + 86_400_000),
    evidence: "CQC reference 1-2345",
    ...o,
  });

  it.each<[string, Partial<StatementOfPurposeVersion>, ReturnType<typeof record>, string[]]>([
    ["by the Registered Manager with step-up", {}, record(), []],
    [
      "by a deputy without the submit permission",
      {},
      record({ permissions: permissionsOf("deputy_manager") }),
      ["missing_permission"],
    ],
    ["without step-up", {}, record({ stepUpFresh: false }), ["step_up_required"]],
    ["for a baseline", { kind: "baseline" }, record(), ["not_required"]],
    ["twice", { notifiedAt: APPROVED }, record(), ["not_required"]],
    ["for a draft", { state: "draft" }, record(), ["not_required"]],
    [
      "dated before approval",
      {},
      record({ sentAt: new Date(APPROVED.getTime() - 1) }),
      ["before_approval"],
    ],
    ["without a reference", {}, record({ evidence: " " }), ["evidence_required"]],
  ])("recording it %s", (_label, o, r, problems) => {
    expect(checkStatementOfPurposeNotificationRecord({ ...approvedRevision, ...o }, r)).toEqual(
      problems,
    );
  });

  it("has a message for every problem", () => {
    for (const m of Object.values(STATEMENT_OF_PURPOSE_NOTIFICATION_MESSAGES)) {
      expect(m.length).toBeGreaterThan(10);
    }
  });
});
