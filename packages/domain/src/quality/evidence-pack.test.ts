import { describe, expect, it } from "vitest";
import { readRateTable, tableEvidencePackPolicy } from "../../test/rate-table";
import { RateNotFoundError } from "../platform/rates";
import { builtinRole } from "../platform/roles";
import { checkWorkflowTransition } from "../platform/workflow";
import { addUkDays } from "../shared/time";
import {
  checkEvidencePackRelease,
  checkEvidencePackRequest,
  composeEvidencePack,
  defaultEvidencePackLinkExpiry,
  EVIDENCE_LINK_MAX_CODE_ATTEMPTS,
  EVIDENCE_PACK_LINK_MESSAGES,
  EVIDENCE_PACK_RELEASE_MESSAGES,
  EVIDENCE_PACK_REQUEST_MESSAGES,
  EVIDENCE_PACK_WORKFLOW,
  EVIDENCE_REDACTION_TEXT,
  type EvidenceExclusionReason,
  type EvidenceField,
  type EvidenceItem,
  type EvidencePack,
  type EvidencePackLinkView,
  type EvidencePackReleaseRequest,
  type EvidencePackRequest,
  type EvidencePackState,
  evidenceItemExclusion,
  evidencePackBundleDeletable,
  evidencePackLinkAccess,
  evidencePackWatermark,
  minimiseEvidenceField,
} from "./evidence-pack";
import { EVIDENCE_PACK_RATE_KEYS, resolveEvidencePackPolicy } from "./rates";

/** Inspector evidence pack (quality.md section 4 rules 1 to 7). Hazard HZ-050. */

const policy = tableEvidencePackPolicy();
const DAY = 86_400_000;
const ADA = "person-ada";
const BEN = "person-ben";
const LOCATION = "location-harbour-house";
const COMPOSED = new Date("2026-10-11T13:05:00Z");

const permissionsOf = (role: string) => new Set(builtinRole(role)?.permissions ?? []);

function field(o: Partial<EvidenceField> & Pick<EvidenceField, "kind">): EvidenceField {
  return {
    key: o.key ?? o.kind,
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
    restricted: false,
    fields: [
      field({ kind: "organisational", key: "type", value: "Fall" }),
      field({ kind: "care_content", key: "injury", value: "Bruised left hip", aboutPersonId: ADA }),
      field({ kind: "third_party", key: "witness", value: "Cara Visitor", role: "visitor" }),
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
  it("has a default no longer than the maximum", () => {
    expect(policy.defaultLinkDays).toBeGreaterThan(0);
    expect(policy.defaultLinkDays).toBeLessThanOrEqual(policy.maxLinkDays);
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
  ] as const)("%s composes: %s, releases: %s", (role, compose_, release) => {
    const permissions = permissionsOf(role);
    expect(permissions.has("quality.evidence_pack.compose")).toBe(compose_);
    expect(permissions.has("quality.evidence_pack.release")).toBe(release);
  });

  it("keeps the inspector to opening packs released to them", () => {
    expect([...permissionsOf("inspector")]).toEqual(["quality.evidence.read"]);
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

describe("hazard HZ-050 fields are minimised and redacted by rule", () => {
  const scope = { peopleInScope: new Set([ADA]), staffNames: "role_only" as const };
  const reviewed = { text: " Fell near [another resident]'s room ", by: "staff-ql", at: COMPOSED };

  it.each<[string, EvidenceField, string, string | null, string | null]>([
    [
      "organisational detail is kept",
      field({ kind: "organisational", value: "Fall" }),
      "included",
      "Fall",
      null,
    ],
    [
      "care content about a person in scope is kept",
      field({ kind: "care_content", value: "Bruised hip", aboutPersonId: ADA }),
      "included",
      "Bruised hip",
      null,
    ],
    [
      "hazard HZ-050 care content about a person outside the pack is withheld",
      field({ kind: "care_content", value: "Ben's diagnosis", aboutPersonId: BEN }),
      "withheld",
      null,
      "person_not_in_scope",
    ],
    [
      "care content about nobody known is withheld",
      field({ kind: "care_content", value: "Something", aboutPersonId: null }),
      "withheld",
      null,
      "person_unknown",
    ],
    [
      "identifiers are left out",
      field({ kind: "direct_identifier", value: "9990000018", aboutPersonId: ADA }),
      "withheld",
      null,
      "identifier_not_needed",
    ],
    [
      "hazard HZ-050 third parties' names are removed",
      field({ kind: "third_party", value: "Cara Visitor", role: " relative " }),
      "redacted",
      "[relative]",
      "third_party",
    ],
    [
      "a third party with no role recorded",
      field({ kind: "third_party", value: "Cara Visitor" }),
      "redacted",
      "[another person]",
      "third_party",
    ],
    [
      "staff names become roles",
      field({ kind: "staff_name", value: "Dan Carer", role: "senior carer" }),
      "redacted",
      "[senior carer]",
      "staff_role_only",
    ],
    [
      "a staff name with no role recorded",
      field({ kind: "staff_name", value: "Dan Carer" }),
      "redacted",
      "[member of staff]",
      "staff_role_only",
    ],
    [
      "hazard HZ-050 free text is withheld until a person has redacted it",
      field({ kind: "free_text", value: "Ada fell near Ben's room" }),
      "withheld",
      null,
      "free_text_not_reviewed",
    ],
    [
      "free text redacted by hand is shown as redacted",
      field({ kind: "free_text", value: "Ada fell near Ben's room", redacted: reviewed }),
      "redacted",
      "Fell near [another resident]'s room",
      "free_text_redacted_by_hand",
    ],
    [
      "a redaction with no reviewer does not count",
      field({ kind: "free_text", value: "x", redacted: { ...reviewed, by: " " } }),
      "withheld",
      null,
      "free_text_not_reviewed",
    ],
  ])("%s", (_label, input, outcome, value, reason) => {
    expect(minimiseEvidenceField(input, scope)).toMatchObject({ outcome, value, reason });
  });

  it("includes staff names only when the request asks for them", () => {
    const named = minimiseEvidenceField(field({ kind: "staff_name", value: "Dan Carer" }), {
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
    expect(pack.items[0]?.fields.find((f) => f.key === "witness")).toMatchObject({
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
    expect(compose(items).items[0]).toMatchObject({ recordId: "record-earlier", recordVersion: 2 });
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

describe("releasing a pack", () => {
  const released = new Date("2026-10-12T09:00:00Z");
  const pack = {
    state: "draft" as EvidencePackState,
    composedBy: "staff-quality-lead",
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
      ["composer_cannot_release"],
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

describe("hazard HZ-050 the link opens only for its recipient before expiry and revocation", () => {
  const expiresAt = new Date("2026-10-19T09:00:00Z");
  const at = new Date("2026-10-13T10:00:00Z");
  function link(o: Partial<EvidencePackLinkView> = {}): EvidencePackLinkView {
    return {
      packState: "released",
      recipientEmail: "ida.inspector@example.invalid",
      expiresAt,
      revokedAt: null,
      failedCodeAttempts: 0,
      ...o,
    };
  }

  it.each<[string, Partial<EvidencePackLinkView>, Date, string | null, string | null]>([
    ["the recipient, after the code", {}, at, "IDA.Inspector@example.invalid ", null],
    ["before the code is entered", {}, at, null, "code_required"],
    [
      "someone else who received a forwarded link",
      {},
      at,
      "ben@example.invalid",
      "wrong_recipient",
    ],
    ["at the moment it expires", {}, expiresAt, "ida.inspector@example.invalid", "expired"],
    [
      "after the provider revoked it",
      { revokedAt: at },
      at,
      "ida.inspector@example.invalid",
      "revoked",
    ],
    ["a revoked pack", { packState: "revoked" }, at, "ida.inspector@example.invalid", "revoked"],
    [
      "a revocation scheduled for later",
      { revokedAt: new Date(at.getTime() + DAY) },
      at,
      "ida.inspector@example.invalid",
      null,
    ],
    [
      "after too many wrong codes",
      { failedCodeAttempts: EVIDENCE_LINK_MAX_CODE_ATTEMPTS },
      at,
      "ida.inspector@example.invalid",
      "locked",
    ],
    [
      "one wrong code short of the limit",
      { failedCodeAttempts: EVIDENCE_LINK_MAX_CODE_ATTEMPTS - 1 },
      at,
      "ida.inspector@example.invalid",
      null,
    ],
    ["a draft", { packState: "draft" }, at, "ida.inspector@example.invalid", "not_released"],
    [
      "a discarded pack",
      { packState: "discarded" },
      at,
      "ida.inspector@example.invalid",
      "not_released",
    ],
  ])("%s", (_label, o, when, verifiedEmail, refusal) => {
    const access = evidencePackLinkAccess(link(o), { at: when, verifiedEmail });
    expect(access.allowed ? null : access.reason).toBe(refusal);
  });

  it("explains every refusal", () => {
    for (const m of Object.values(EVIDENCE_PACK_LINK_MESSAGES))
      expect(m.length).toBeGreaterThan(10);
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
