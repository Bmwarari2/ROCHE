import { describe, expect, it } from "vitest";
import { readRateTable, tableEvidencePackPolicy } from "../../test/rate-table";
import { RateNotFoundError } from "../platform/rates";
import { builtinRole } from "../platform/roles";
import { checkWorkflowTransition } from "../platform/workflow";
import { addUkDays } from "../shared/time";
import {
  checkEvidencePackCode,
  checkEvidencePackLinkReissue,
  checkEvidencePackRelease,
  checkEvidencePackRequest,
  composeEvidencePack,
  defaultEvidencePackLinkExpiry,
  EVIDENCE_FIELD_KIND_MAP,
  EVIDENCE_LINK_CODE_DIGITS,
  EVIDENCE_LINK_MAX_CODE_ATTEMPTS,
  EVIDENCE_PACK_LINK_MESSAGES,
  EVIDENCE_PACK_RELEASE_MESSAGES,
  EVIDENCE_PACK_REQUEST_MESSAGES,
  EVIDENCE_PACK_WORKFLOW,
  EVIDENCE_RECORD_TYPES,
  EVIDENCE_REDACTION_TEXT,
  type EvidenceExclusionReason,
  type EvidenceField,
  type EvidenceFieldKind,
  type EvidenceItem,
  type EvidencePack,
  type EvidencePackCodeView,
  type EvidencePackLinkView,
  type EvidencePackReleaseRequest,
  type EvidencePackRequest,
  type EvidencePackState,
  evidenceFieldKind,
  evidenceItemExclusion,
  evidencePackBundleDeletable,
  evidencePackContributors,
  evidencePackLinkAccess,
  evidencePackWatermark,
  failedCodeAttemptsAfter,
  isWellFormedEvidenceCode,
  minimiseEvidenceField,
  redactionLeaks,
} from "./evidence-pack";
import {
  EVIDENCE_CODE_MAX_VALID_MINUTES,
  EVIDENCE_PACK_RATE_KEYS,
  resolveEvidencePackPolicy,
} from "./rates";

/** Inspector evidence pack (quality.md section 4 rules 1 to 10). Hazard HZ-050. */

const policy = tableEvidencePackPolicy();
const DAY = 86_400_000;
const MINUTE = 60_000;
const ADA = "person-ada";
const BEN = "person-ben";
const LOCATION = "location-harbour-house";
const COMPOSED = new Date("2026-10-11T13:05:00Z");

const permissionsOf = (role: string) => new Set(builtinRole(role)?.permissions ?? []);

function field(o: Partial<EvidenceField> & Pick<EvidenceField, "key">): EvidenceField {
  return {
    label: o.label ?? "Field",
    value: "value",
    aboutPersonId: null,
    role: null,
    redacted: null,
    ...o,
  };
}

function item(id: string, o: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id,
    recordType: "incident",
    recordId: `record-${id}`,
    recordVersion: 2,
    locationId: LOCATION,
    occurredAt: new Date("2026-09-15T10:00:00Z"),
    title: "Fall incident",
    qualityStatementIds: ["safe.learning_culture"],
    aboutPersonIds: [ADA],
    namedPeople: [{ personId: ADA, names: ["Ada Example", "Ada", "Example", "Addie"] }],
    restricted: false,
    fields: [
      field({ key: "type", value: "Fall" }),
      field({ key: "injury", value: "Bruised left hip", aboutPersonId: ADA }),
      field({ key: "witness_other", value: "Cara Visitor", role: "visitor" }),
    ],
    ...o,
  };
}

function request(o: Partial<EvidencePackRequest> = {}): EvidencePackRequest {
  return {
    packId: "EP-0001",
    recipient: {
      name: "Ida Inspector",
      organisation: "Care Quality Commission",
      email: "Ida.Inspector@example.invalid",
    },
    purpose: "Assessment of Harbour House, safe key question",
    from: "2026-09-01",
    to: "2026-09-30",
    locationIds: [LOCATION],
    qualityStatementIds: null,
    peopleInScope: [ADA],
    staffNames: "role_only",
    composedBy: "staff-quality-lead",
    composedAt: COMPOSED,
    ...o,
  };
}

function compose(items: EvidenceItem[], o: Partial<EvidencePackRequest> = {}): EvidencePack {
  const result = composeEvidencePack(request(o), items);
  if (!result.ok) throw new Error(result.problems.join());
  return result.pack;
}

describe("evidence pack link figures come from the rate table as tenant defaults", () => {
  it("has a default no longer than the maximum, and a short code lifetime", () => {
    expect(policy.defaultLinkDays).toBeGreaterThan(0);
    expect(policy.defaultLinkDays).toBeLessThanOrEqual(policy.maxLinkDays);
    expect(policy.codeValidMinutes).toBeGreaterThan(0);
    expect(policy.codeValidMinutes).toBeLessThanOrEqual(10);
  });

  it("fails loudly when a figure is missing", () => {
    const rows = readRateTable().filter((r) => r.key !== EVIDENCE_PACK_RATE_KEYS.maxLinkDays);
    expect(() => resolveEvidencePackPolicy(rows, "england", "2026-10-11", null)).toThrow(
      RateNotFoundError,
    );
  });

  it("applies in Wales too (a policy default, not a statutory figure)", () => {
    expect(resolveEvidencePackPolicy(readRateTable(), "wales", "2026-10-11", null)).toEqual(policy);
  });

  it.each([
    [5, 5],
    [60, EVIDENCE_CODE_MAX_VALID_MINUTES],
  ])("lets a tenant shorten the code lifetime but never lengthen it (%i minutes)", (asked, got) => {
    const base = readRateTable().find((r) => r.key === EVIDENCE_PACK_RATE_KEYS.codeValidMinutes);
    if (!base) throw new Error("code_valid_minutes row missing");
    const rows = [...readRateTable(), { ...base, value: asked, tenantId: "tenant-a" }];
    const tenant = resolveEvidencePackPolicy(rows, "england", "2026-10-11", "tenant-a");
    expect(tenant.codeValidMinutes).toBe(got);
  });
});

describe("evidence pack permissions", () => {
  it.each([
    ["quality_lead", true, true],
    ["registered_manager", true, true],
    ["owner", true, true],
    ["clinical_lead", false, false],
    ["care_worker", false, false],
    ["inspector", false, false],
    ["group_executive", false, false],
  ] as const)("%s composes: %s, releases: %s", (role, canCompose, canRelease) => {
    const permissions = permissionsOf(role);
    expect(permissions.has("quality.evidence_pack.compose")).toBe(canCompose);
    expect(permissions.has("quality.evidence_pack.release")).toBe(canRelease);
  });

  it("gives opening a released pack to the inspector role alone (least privilege)", () => {
    expect([...permissionsOf("inspector")]).toEqual(["quality.evidence.read"]);
    for (const role of [
      "owner",
      "registered_manager",
      "deputy_manager",
      "quality_lead",
      "group_executive",
    ]) {
      expect(permissionsOf(role).has("quality.evidence.read"), role).toBe(false);
    }
  });
});

describe("the pack request", () => {
  it.each<[string, Partial<EvidencePackRequest>, string[]]>([
    ["a complete request", {}, []],
    [
      "no recipient name or organisation",
      { recipient: { name: " ", organisation: "", email: "ida@example.invalid" } },
      ["recipient_name_missing", "recipient_organisation_missing"],
    ],
    [
      "a mistyped email",
      { recipient: { name: "Ida", organisation: "CQC", email: "ida@example" } },
      ["recipient_email_invalid"],
    ],
    ["a vague purpose", { purpose: "Inspection" }, ["purpose_too_short"]],
    ["dates the wrong way round", { from: "2026-09-30", to: "2026-09-01" }, ["date_range_invalid"]],
    ["an impossible date", { from: "2026-02-30" }, ["date_range_invalid"]],
    ["no locations", { locationIds: [] }, ["no_locations"]],
  ])("%s", (_label, o, problems) => {
    expect(checkEvidencePackRequest(request(o))).toEqual(problems);
  });

  it("has a message for every problem", () => {
    for (const m of Object.values(EVIDENCE_PACK_REQUEST_MESSAGES)) {
      expect(m.length).toBeGreaterThan(10);
    }
  });

  it("refuses to compose from an invalid request", () => {
    expect(composeEvidencePack(request({ locationIds: [] }), [item("a")])).toEqual({
      ok: false,
      problems: ["no_locations"],
    });
  });
});

describe("hazard HZ-050 the field-to-kind map decides how every field is treated", () => {
  it("covers every evidence record type", () => {
    expect(Object.keys(EVIDENCE_FIELD_KIND_MAP).sort()).toEqual([...EVIDENCE_RECORD_TYPES].sort());
  });

  it.each<[(typeof EVIDENCE_RECORD_TYPES)[number], string, EvidenceFieldKind]>([
    ["incident", "description", "free_text"],
    ["incident", "immediate_actions", "free_text"],
    ["incident", "witness_other", "third_party"],
    ["care_note", "text", "free_text"],
    ["care_note", "author", "staff_name"],
    ["visit_log", "visitor_name", "third_party"],
    ["visit_log", "visitor_relationship", "free_text"],
    ["visit_log", "restriction_reason", "free_text"],
    ["care_plan_section", "need", "free_text"],
    ["risk_assessment", "controls", "free_text"],
    ["advance_care_record", "clinician_name", "third_party"],
    ["observation", "nhs_number", "direct_identifier"],
    ["observation", "values", "care_content"],
    ["incident", "a_column_nobody_mapped", "free_text"],
  ])("%s.%s is %s", (recordType, key, kind) => {
    expect(evidenceFieldKind(recordType, key)).toBe(kind);
  });

  it("treats every field a person types as free text", () => {
    const typedFields = ["description", "text", "notes", "note", "need", "outcome", "details"];
    for (const fields of Object.values(EVIDENCE_FIELD_KIND_MAP)) {
      for (const [key, kind] of Object.entries(fields)) {
        if (typedFields.includes(key)) expect(kind, key).toBe("free_text");
      }
    }
  });

  it("ignores any kind the caller tries to give a field", () => {
    const sneaky = {
      ...field({ key: "description", value: "Ben hit Ada" }),
      kind: "organisational",
    };
    const pack = compose([item("a", { fields: [sneaky] })]);
    expect(pack.items[0]?.fields[0]).toMatchObject({
      kind: "free_text",
      outcome: "withheld",
      reason: "free_text_not_reviewed",
    });
  });
});

describe("hazard HZ-050 fields are minimised and redacted by rule", () => {
  const scope = { peopleInScope: new Set([ADA]), staffNames: "role_only" as const };
  const reviewed = { text: " Fell near the lounge ", by: "staff-ql", at: COMPOSED };
  const typed = (kind: EvidenceFieldKind, o: Partial<EvidenceField> = {}) => ({
    ...field({ key: kind, ...o }),
    kind,
  });

  it.each<[string, ReturnType<typeof typed>, string, string | null, string | null]>([
    [
      "organisational detail is kept",
      typed("organisational", { value: "Fall" }),
      "included",
      "Fall",
      null,
    ],
    [
      "care content about a person in scope is kept",
      typed("care_content", { value: "Bruised hip", aboutPersonId: ADA }),
      "included",
      "Bruised hip",
      null,
    ],
    [
      "hazard HZ-050 care content about a person outside the pack is withheld",
      typed("care_content", { value: "Ben's diagnosis", aboutPersonId: BEN }),
      "withheld",
      null,
      "person_not_in_scope",
    ],
    [
      "care content about nobody known is withheld",
      typed("care_content", { value: "Something", aboutPersonId: null }),
      "withheld",
      null,
      "person_unknown",
    ],
    [
      "identifiers are left out",
      typed("direct_identifier", { value: "9990000018", aboutPersonId: ADA }),
      "withheld",
      null,
      "identifier_not_needed",
    ],
    [
      "hazard HZ-050 third parties' names are removed",
      typed("third_party", { value: "Cara Visitor", role: "relative" }),
      "redacted",
      "[relative]",
      "third_party",
    ],
    [
      "a third party with no role recorded",
      typed("third_party", { value: "Cara Visitor" }),
      "redacted",
      "[another person]",
      "third_party",
    ],
    [
      "a role outside the closed list is never printed",
      typed("third_party", { value: "Cara Visitor", role: "Cara's daughter" as never }),
      "redacted",
      "[another person]",
      "third_party",
    ],
    [
      "staff names become roles",
      typed("staff_name", { value: "Dan Carer", role: "senior carer" }),
      "redacted",
      "[senior carer]",
      "staff_role_only",
    ],
    [
      "a staff name with no role recorded",
      typed("staff_name", { value: "Dan Carer" }),
      "redacted",
      "[member of staff]",
      "staff_role_only",
    ],
    [
      "hazard HZ-050 free text is withheld until a person has redacted it",
      typed("free_text", { value: "Ada fell near Ben's room" }),
      "withheld",
      null,
      "free_text_not_reviewed",
    ],
    [
      "free text redacted by hand is shown as redacted",
      typed("free_text", { value: "Ada fell near Ben's room", redacted: reviewed }),
      "redacted",
      "Fell near the lounge",
      "free_text_redacted_by_hand",
    ],
    [
      "a redaction with no reviewer does not count",
      typed("free_text", { value: "x", redacted: { ...reviewed, by: " " } }),
      "withheld",
      null,
      "free_text_not_reviewed",
    ],
  ])("%s", (_label, input, outcome, value, reason) => {
    expect(minimiseEvidenceField(input, scope)).toMatchObject({ outcome, value, reason });
  });

  it("records who redacted free text by hand", () => {
    expect(
      minimiseEvidenceField(typed("free_text", { value: "x", redacted: reviewed }), scope)
        .redactedBy,
    ).toBe("staff-ql");
  });

  it("includes staff names only when the request asks for them", () => {
    const named = minimiseEvidenceField(typed("staff_name", { value: "Dan Carer" }), {
      peopleInScope: new Set(),
      staffNames: "include",
    });
    expect(named).toMatchObject({ outcome: "included", value: "Dan Carer" });
  });

  it("explains every redaction in words", () => {
    for (const text of Object.values(EVIDENCE_REDACTION_TEXT)) {
      expect(text.length).toBeGreaterThan(15);
    }
  });
});

describe("hazard HZ-050 hand-redacted text that still names someone is withheld", () => {
  const redactedBy = { by: "staff-ql", at: COMPOSED };
  function withNote(
    text: string,
    o: Partial<EvidenceItem> = {},
    staffNames: "role_only" | "include" = "role_only",
  ) {
    const pack = compose(
      [
        item("a", {
          aboutPersonIds: [ADA, BEN],
          namedPeople: [
            { personId: ADA, names: ["Ada Example"] },
            { personId: BEN, names: ["Ben Other", "Benjamin"] },
          ],
          fields: [
            field({ key: "witness_other", value: "Cara Visitor", role: "visitor" }),
            field({ key: "raised_by", value: "Dan Carer", role: "senior carer" }),
            field({ key: "description", value: "original", redacted: { text, ...redactedBy } }),
          ],
          ...o,
        }),
      ],
      { staffNames },
    );
    return pack.items[0]?.fields.find((f) => f.key === "description");
  }

  it.each<[string, string, "role_only" | "include", string]>([
    ["text with no names left", "Ada fell near the lounge door", "role_only", "redacted"],
    ["a third party's full name", "Cara Visitor saw the fall", "role_only", "withheld"],
    ["part of a third party's name, in any case", "seen by CARA", "role_only", "withheld"],
    ["a staff name while only roles are shown", "Dan helped Ada up", "role_only", "withheld"],
    ["a staff name when staff names are included", "Dan helped Ada up", "include", "redacted"],
    [
      "the name of an out-of-scope person on the record",
      "Benjamin was nearby",
      "role_only",
      "withheld",
    ],
    ["an NHS number with spaces", "Reference 999 000 0018", "role_only", "withheld"],
    ["a telephone number", "Called 01632 960000", "role_only", "withheld"],
    ["a short number", "Room 12, bed 2", "role_only", "redacted"],
  ])("%s", (_label, text, staffNames, outcome) => {
    const description = withNote(text, {}, staffNames);
    expect(description?.outcome).toBe(outcome);
    if (outcome === "withheld") expect(description?.reason).toBe("redaction_incomplete");
  });

  it("ignores very short name parts that would match ordinary words", () => {
    expect(redactionLeaks("Jo went to the shop", ["Al Jo"])).toBe(false);
    expect(redactionLeaks("al jo was there", ["Al Jo"])).toBe(true);
  });
});

describe("hazard HZ-050 items outside the request are excluded", () => {
  it.each<
    [string, Partial<EvidenceItem>, Partial<EvidencePackRequest>, EvidenceExclusionReason | null]
  >([
    ["an item that belongs in the pack", {}, {}, null],
    ["a speak-up concern", { restricted: true }, {}, "restricted_record"],
    [
      "an item before the date range",
      { occurredAt: new Date("2026-08-31T22:59:00Z") },
      {},
      "outside_date_range",
    ],
    [
      "an item at midnight UK time after the last day",
      { occurredAt: new Date("2026-09-30T23:00:00Z") },
      {},
      "outside_date_range",
    ],
    [
      "an item at 23:30 UK time on the last day",
      { occurredAt: new Date("2026-09-30T22:30:00Z") },
      {},
      null,
    ],
    [
      "an item at midnight UK time on the first day",
      { occurredAt: new Date("2026-08-31T23:00:00Z") },
      {},
      null,
    ],
    ["another location", { locationId: "location-other" }, {}, "location_not_requested"],
    ["an untagged record", { qualityStatementIds: [] }, {}, "not_tagged"],
    [
      "a statement not asked for",
      {},
      { qualityStatementIds: ["well_led.governance"] },
      "statement_not_requested",
    ],
    [
      "hazard HZ-050 people outside the pack's scope are excluded",
      { aboutPersonIds: [BEN] },
      {},
      "person_not_in_scope",
    ],
    ["an organisational record about nobody", { aboutPersonIds: [] }, {}, null],
    ["a record about two people, one in scope", { aboutPersonIds: [BEN, ADA] }, {}, null],
  ])("%s", (_label, itemOverrides, requestOverrides, reason) => {
    expect(evidenceItemExclusion(item("a", itemOverrides), request(requestOverrides))).toBe(reason);
  });
});

describe("composing a pack", () => {
  const items = [
    item("later", { occurredAt: new Date("2026-09-20T10:00:00Z") }),
    item("earlier", {
      occurredAt: new Date("2026-09-02T10:00:00Z"),
      qualityStatementIds: ["safe.learning_culture", "well_led.governance"],
    }),
    item("restricted", { restricted: true }),
    item("ben-only", { aboutPersonIds: [BEN] }),
  ];

  it("selects, orders and minimises the evidence, and records what it left out", () => {
    const pack = compose(items);
    expect(pack.items.map((i) => i.itemId)).toEqual(["earlier", "later"]);
    expect(pack.excluded).toEqual([
      { itemId: "restricted", reason: "restricted_record" },
      { itemId: "ben-only", reason: "person_not_in_scope" },
    ]);
    expect(pack.coverage).toEqual({ "safe.learning_culture": 2, "well_led.governance": 1 });
    expect(pack.redactedFields).toBe(2);
    expect(pack.withheldFields).toBe(0);
    expect(pack.recipient.email).toBe("ida.inspector@example.invalid");
    expect(pack.items[0]?.fields.find((f) => f.key === "witness_other")).toMatchObject({
      outcome: "redacted",
      value: "[visitor]",
    });
    expect(JSON.stringify(pack.items)).not.toContain("Cara Visitor");
  });

  it("keeps only the requested statements on each item", () => {
    const pack = compose(items, { qualityStatementIds: ["well_led.governance"] });
    expect(pack.items.map((i) => [i.itemId, i.qualityStatementIds])).toEqual([
      ["earlier", ["well_led.governance"]],
    ]);
  });

  it("keeps the record version so the manifest can rebuild the pack", () => {
    expect(compose(items).items[0]).toMatchObject({
      recordId: "record-earlier",
      recordVersion: 2,
    });
  });
});

describe("the watermark", () => {
  it("names the recipient, the purpose, the time and the pack on every page", () => {
    expect(compose([item("a")]).watermark).toBe(
      "Prepared for Ida Inspector, Care Quality Commission. Purpose: Assessment of Harbour House, safe key question. Made 11/10/2026 14:05. Pack EP-0001. Do not share further.",
    );
  });

  it("shortens a long purpose at a word boundary", () => {
    const watermark = evidencePackWatermark({
      packId: "EP-2",
      recipient: { name: "Ida", organisation: "CQC" },
      purpose: `Assessment ${"of the home ".repeat(20)}`,
      generatedAt: COMPOSED,
    });
    const purpose = watermark.split("Purpose: ")[1]?.split(". Made")[0] ?? "";
    expect(purpose.endsWith("...")).toBe(true);
    expect(purpose.length).toBeLessThanOrEqual(80);
  });

  it("shortens a purpose with no spaces", () => {
    const watermark = evidencePackWatermark({
      packId: "EP-3",
      recipient: { name: "Ida", organisation: "CQC" },
      purpose: "x".repeat(100),
      generatedAt: COMPOSED,
    });
    expect(watermark).toContain(`Purpose: ${"x".repeat(77)}....`);
  });
});

describe("hazard HZ-050 releasing a pack: nobody who shaped it may release it", () => {
  const released = new Date("2026-10-12T09:00:00Z");
  const pack = {
    state: "draft" as EvidencePackState,
    composedBy: "staff-quality-lead",
    contributorIds: ["staff-quality-lead", "staff-redactor", "staff-editor"],
    itemCount: 2,
    recipientEmail: "ida.inspector@example.invalid",
  };
  function release(o: Partial<EvidencePackReleaseRequest> = {}): EvidencePackReleaseRequest {
    return {
      actorId: "staff-manager",
      permissions: permissionsOf("registered_manager"),
      stepUpFresh: true,
      releasedAt: released,
      expiresAt: null,
      ...o,
    };
  }

  it("works out every contributor: the composer, each hand redactor and each editor", () => {
    const composed = compose([
      item("a", {
        fields: [
          field({
            key: "description",
            value: "x",
            redacted: { text: "Fell in the lounge", by: "staff-redactor", at: COMPOSED },
          }),
        ],
      }),
    ]);
    expect([...evidencePackContributors(composed, ["staff-editor"])].sort()).toEqual([
      "staff-editor",
      "staff-quality-lead",
      "staff-redactor",
    ]);
  });

  it("issues the link with the default expiry when none is chosen", () => {
    expect(checkEvidencePackRelease(pack, release(), policy)).toEqual({
      ok: true,
      expiresAt: defaultEvidencePackLinkExpiry(released, policy),
    });
    expect(defaultEvidencePackLinkExpiry(released, policy)).toEqual(
      addUkDays(released, policy.defaultLinkDays),
    );
  });

  it("accepts an expiry up to the maximum", () => {
    const max = addUkDays(released, policy.maxLinkDays);
    expect(checkEvidencePackRelease(pack, release({ expiresAt: max }), policy)).toEqual({
      ok: true,
      expiresAt: max,
    });
  });

  it.each<[string, Partial<typeof pack>, Partial<EvidencePackReleaseRequest>, string[]]>([
    [
      "by the person who composed it",
      {},
      { actorId: "staff-quality-lead", permissions: permissionsOf("quality_lead") },
      ["contributor_cannot_release"],
    ],
    [
      "hazard HZ-050 by someone who redacted free text in it",
      {},
      { actorId: "staff-redactor" },
      ["contributor_cannot_release"],
    ],
    [
      "hazard HZ-050 by someone who edited it",
      {},
      { actorId: "staff-editor" },
      ["contributor_cannot_release"],
    ],
    ["without a recent sign-in", {}, { stepUpFresh: false }, ["step_up_required"]],
    [
      "by a role without the permission",
      {},
      { permissions: permissionsOf("clinical_lead") },
      ["missing_permission"],
    ],
    ["a pack already released", { state: "released" }, {}, ["not_draft"]],
    ["a discarded pack", { state: "discarded" }, {}, ["not_draft"]],
    ["an empty pack", { itemCount: 0 }, {}, ["empty_pack"]],
    ["a bad recipient address", { recipientEmail: "ida" }, {}, ["recipient_email_invalid"]],
    [
      "an expiry in the past",
      {},
      { expiresAt: new Date(released.getTime() - 1) },
      ["expiry_in_past"],
    ],
    [
      "an expiry beyond the maximum",
      {},
      { expiresAt: new Date(addUkDays(released, policy.maxLinkDays).getTime() + DAY) },
      ["expiry_beyond_maximum"],
    ],
  ])("refuses a release %s", (_label, packOverrides, requestOverrides, problems) => {
    const check = checkEvidencePackRelease(
      { ...pack, ...packOverrides },
      release(requestOverrides),
      policy,
    );
    expect(check.ok ? null : check.problems).toEqual(problems);
  });

  it("has a message for every release problem", () => {
    for (const m of Object.values(EVIDENCE_PACK_RELEASE_MESSAGES)) {
      expect(m.length).toBeGreaterThan(10);
    }
  });

  it("needs a reason to revoke or discard", () => {
    const base = {
      actorId: "staff-manager",
      permissions: permissionsOf("registered_manager"),
      stepUpFresh: false,
    };
    const revoke = (reason: string | null) =>
      checkWorkflowTransition(
        EVIDENCE_PACK_WORKFLOW,
        { state: "released", createdBy: "staff-quality-lead" },
        { ...base, to: "revoked", reason },
      );
    expect(revoke(null)).toMatchObject({ ok: false, problem: "reason_required" });
    expect(revoke("Sent to the wrong inspector").ok).toBe(true);
    const discard = checkWorkflowTransition(
      EVIDENCE_PACK_WORKFLOW,
      { state: "draft", createdBy: "staff-quality-lead" },
      { ...base, to: "discarded", reason: "Not needed" },
    );
    expect(discard.ok).toBe(true);
  });
});

describe("hazard HZ-050 issuing a new link is a release", () => {
  const now = new Date("2026-10-15T09:00:00Z");
  const pack = {
    state: "released" as EvidencePackState,
    contributorIds: ["staff-quality-lead", "staff-redactor"],
    recipientEmail: "ida.inspector@example.invalid",
  };
  const reissue = (o: Partial<Parameters<typeof checkEvidencePackLinkReissue>[2]> = {}) =>
    checkEvidencePackLinkReissue(
      pack,
      { linkId: "link-1" },
      {
        actorId: "staff-manager",
        permissions: permissionsOf("registered_manager"),
        stepUpFresh: true,
        releasedAt: now,
        expiresAt: null,
        recipientEmail: " IDA.Inspector@example.invalid",
        ...o,
      },
      policy,
    );

  it("revokes the old link when a new one goes to the same recipient", () => {
    expect(reissue()).toEqual({
      ok: true,
      expiresAt: defaultEvidencePackLinkExpiry(now, policy),
      revokeLinkId: "link-1",
    });
  });

  it.each<[string, Partial<Parameters<typeof checkEvidencePackLinkReissue>[2]>, string[]]>([
    [
      "to a different recipient",
      { recipientEmail: "ben@example.invalid" },
      ["different_recipient"],
    ],
    ["by a contributor", { actorId: "staff-redactor" }, ["contributor_cannot_release"]],
    ["without step-up", { stepUpFresh: false }, ["step_up_required"]],
    [
      "by a role without the permission",
      { permissions: permissionsOf("care_worker") },
      ["missing_permission"],
    ],
    [
      "beyond the maximum expiry",
      { expiresAt: new Date(addUkDays(now, policy.maxLinkDays).getTime() + DAY) },
      ["expiry_beyond_maximum"],
    ],
  ])("refuses a new link %s", (_label, o, problems) => {
    const check = reissue(o);
    expect(check.ok ? null : check.problems).toEqual(problems);
  });

  it("refuses a new link for a pack that is not released", () => {
    const check = checkEvidencePackLinkReissue(
      { ...pack, state: "revoked" },
      { linkId: "link-1" },
      {
        actorId: "staff-manager",
        permissions: permissionsOf("registered_manager"),
        stepUpFresh: true,
        releasedAt: now,
        expiresAt: null,
        recipientEmail: pack.recipientEmail,
      },
      policy,
    );
    expect(check.ok ? null : check.problems).toEqual(["not_released"]);
  });
});

describe("hazard HZ-050 one-time codes", () => {
  const issuedAt = new Date("2026-10-13T10:00:00Z");
  const code: EvidencePackCodeView = { linkId: "link-1", issuedAt, usedAt: null };

  it("issues six-digit codes only", () => {
    expect(EVIDENCE_LINK_CODE_DIGITS).toBeGreaterThanOrEqual(6);
    expect(isWellFormedEvidenceCode("123456")).toBe(true);
    for (const bad of ["12345", "1234567", "12345a", "١٢٣٤٥٦", " 12345"]) {
      expect(isWellFormedEvidenceCode(bad), bad).toBe(false);
    }
  });

  it.each<
    [
      string,
      Partial<typeof code>,
      { linkId?: string; entered?: string; matches?: boolean; at?: Date },
      string,
    ]
  >([
    ["the right code in time", {}, {}, "accepted"],
    ["a wrong code", {}, { matches: false }, "wrong_code"],
    ["a code for another link", {}, { linkId: "link-2" }, "wrong_link"],
    ["a code that is not six digits", {}, { entered: "12345" }, "malformed"],
    ["a code already used", { usedAt: issuedAt }, {}, "already_used"],
    [
      "a code at the end of its life",
      {},
      { at: new Date(issuedAt.getTime() + policy.codeValidMinutes * MINUTE) },
      "expired",
    ],
    [
      "a code a minute before the end of its life",
      {},
      { at: new Date(issuedAt.getTime() + (policy.codeValidMinutes - 1) * MINUTE) },
      "accepted",
    ],
  ])("%s", (_label, codeOverrides, attempt, expected) => {
    expect(
      checkEvidencePackCode(
        { ...code, ...codeOverrides },
        {
          linkId: "link-1",
          entered: "123456",
          matches: true,
          at: new Date(issuedAt.getTime() + MINUTE),
          ...attempt,
        },
        policy,
      ),
    ).toBe(expected);
  });

  it("never resets the failed-attempt count, even after a correct code", () => {
    let count = 0;
    for (const outcome of ["wrong", "wrong", "correct", "wrong"] as const) {
      count = failedCodeAttemptsAfter(count, outcome);
    }
    expect(count).toBe(3);
  });
});

describe("hazard HZ-050 the link opens only for its recipient's own session, before expiry and revocation", () => {
  const expiresAt = new Date("2026-10-19T09:00:00Z");
  const at = new Date("2026-10-13T10:00:00Z");
  const session = { linkId: "link-1", verifiedEmail: "IDA.Inspector@example.invalid " };
  function link(o: Partial<EvidencePackLinkView> = {}): EvidencePackLinkView {
    return {
      id: "link-1",
      packState: "released",
      recipientEmail: "ida.inspector@example.invalid",
      expiresAt,
      revokedAt: null,
      failedCodeAttempts: 0,
      ...o,
    };
  }

  it.each<[string, Partial<EvidencePackLinkView>, Date, typeof session | null, string | null]>([
    ["the recipient, in the session their code opened", {}, at, session, null],
    ["before the code is entered", {}, at, null, "code_required"],
    [
      "a session opened for a different link",
      {},
      at,
      { ...session, linkId: "link-old" },
      "code_required",
    ],
    [
      "someone else who received a forwarded link",
      {},
      at,
      { linkId: "link-1", verifiedEmail: "ben@example.invalid" },
      "wrong_recipient",
    ],
    ["at the moment it expires", {}, expiresAt, session, "expired"],
    ["after the provider revoked it", { revokedAt: at }, at, session, "revoked"],
    ["a revoked pack", { packState: "revoked" }, at, session, "revoked"],
    [
      "a revocation scheduled for later",
      { revokedAt: new Date(at.getTime() + DAY) },
      at,
      session,
      null,
    ],
    [
      "after too many wrong codes",
      { failedCodeAttempts: EVIDENCE_LINK_MAX_CODE_ATTEMPTS },
      at,
      session,
      "locked",
    ],
    [
      "one wrong code short of the limit",
      { failedCodeAttempts: EVIDENCE_LINK_MAX_CODE_ATTEMPTS - 1 },
      at,
      session,
      null,
    ],
    ["a draft", { packState: "draft" }, at, session, "not_released"],
    ["a discarded pack", { packState: "discarded" }, at, session, "not_released"],
  ])("%s", (_label, o, when, s, refusal) => {
    const access = evidencePackLinkAccess(link(o), { at: when, session: s });
    expect(access.allowed ? null : access.reason).toBe(refusal);
  });

  it("explains every refusal", () => {
    for (const m of Object.values(EVIDENCE_PACK_LINK_MESSAGES)) {
      expect(m.length).toBeGreaterThan(10);
    }
  });

  it.each<[string, Partial<EvidencePackLinkView>, Date, boolean]>([
    ["a live link", {}, at, false],
    ["an expired link", {}, expiresAt, true],
    ["a revoked link", { revokedAt: at }, at, true],
    ["a revoked pack", { packState: "revoked" }, at, true],
    ["a discarded pack", { packState: "discarded" }, at, true],
  ])("deletes the rendered bundle for %s: %s", (_label, o, when, expected) => {
    expect(evidencePackBundleDeletable(link(o), when)).toBe(expected);
  });
});
