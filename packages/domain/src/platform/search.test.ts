import { describe, expect, it } from "vitest";
import { tablePlatformRates } from "../../test/rate-table";
import type { PersonStatus } from "../people/lifecycle";
import { type EffectiveAccess, resolveAccess } from "./access";
import { builtinRole } from "./roles";
import {
  agencyAccessEndsAt,
  BREAK_GLASS_RESULT_FIELDS,
  type BreakGlassSearchRequest,
  breakGlassSearchAlert,
  buildBreakGlassSearchPlan,
  buildSearchPlan,
  compareSearchHits,
  filterSearchResults,
  normaliseSearchQuery,
  SEARCH_CLOSED_PERSON_STATUSES,
  SEARCH_LIMITS,
  type SearchActor,
  type SearchEntityType,
  type SearchHit,
  type SearchPlan,
  type SearchPlanProblem,
  sameNameWarnings,
  searchAuditEvent,
  searchRefusalAuditEvent,
  searchTerms,
} from "./search";

const NOW = new Date("2026-10-11T10:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const NORTH = "0193a000-0000-7000-8000-000000000101";
const SOUTH = "0193a000-0000-7000-8000-000000000102";
const STEP_UP_SECONDS = 600;
const RATES = tablePlatformRates();
const SHIFT_END = new Date("2026-10-11T20:00:00Z");

function accessFor(roleKey: string, locationId: string | null = null): EffectiveAccess {
  const role = builtinRole(roleKey);
  if (!role) throw new Error(`unknown role ${roleKey}`);
  return resolveAccess(
    [
      {
        roleKey,
        scopeKind: role.scopeKind,
        permissions: role.permissions,
        locationId,
        organisationWide: locationId === null,
        validFrom: PAST,
        validTo: null,
      },
    ],
    [],
    NOW,
  );
}

function actor(
  roleKey: string,
  locationId: string | null = null,
  extra: Partial<SearchActor> = {},
): SearchActor {
  const agency = roleKey === "agency_worker";
  return {
    access: accessFor(roleKey, locationId),
    mfaEnrolled: true,
    window: {
      roleEndsAt: null,
      isAgencyWorker: agency,
      agencyShiftEndsAt: agency ? SHIFT_END : null,
    },
    ...extra,
  };
}

function planFor(
  who: SearchActor,
  rawQuery = "Ada Example",
  extra: { entityTypes?: SearchEntityType[]; includeArchived?: boolean } = {},
  now = NOW,
): SearchPlan {
  const result = buildSearchPlan({ rawQuery, ...extra }, who, now, RATES);
  if (!result.ok) throw new Error(`expected a plan, got ${result.problem}`);
  return result.plan;
}

let counter = 0;
function hit(extra: Partial<SearchHit> = {}): SearchHit {
  counter += 1;
  return {
    entityType: "person",
    id: `hit-${String(counter).padStart(3, "0")}`,
    rank: 1,
    matchQuality: "exact",
    sortName: `Person ${counter} Example`,
    dateOfBirth: "1940-01-01",
    personId: `p-${String(counter).padStart(3, "0")}`,
    personStatus: "active",
    personLocationId: NORTH,
    assignedToActor: false,
    ...extra,
  };
}

describe("search terms match the index's normalisation", () => {
  it.each<[string, string, string[]]>([
    ["a first and last name", "Ada Example", ["ada", "example"]],
    ["an apostrophe joins a name", "O'Brien", ["obrien"]],
    ["a typographic apostrophe joins a name", "O’Brien", ["obrien"]],
    ["accents are removed", "Zoë Éxample", ["zoe", "example"]],
    ["a hyphen separates", "Smith-Example", ["smith", "example"]],
    ["sharp s and slashed letters fold", "Straße Ørsted Łukasz", ["strasse", "orsted", "lukasz"]],
    ["digits are terms", "  room 12  ", ["room", "12"]],
    ["an email address splits", "ada@example.invalid", ["ada", "example", "invalid"]],
    ["full-width letters fold", "ＡＤＡ", ["ada"]],
    ["symbols separate", "Ada % Example", ["ada", "example"]],
    ["nothing searchable", "' - ! ?", []],
  ])("%s", (_label, text, expected) => {
    expect(searchTerms(text)).toEqual(expected);
  });
});

describe("query normalisation (hazard HZ-001: an NHS number is exact, never a near match)", () => {
  it.each<[string, string, SearchPlanProblem | null, string[] | string | null]>([
    ["an empty query", "", "empty", null],
    ["only spaces", "    ", "empty", null],
    ["one letter", "a", "too_short", null],
    ["only one-letter words", "a b c", "too_short", null],
    ["only punctuation", "'''''", "too_short", null],
    ["a long query", "x".repeat(SEARCH_LIMITS.maxQueryLength + 1), "too_long", null],
    ["a name", "Ada Example", null, ["ada", "example"]],
    ["a repeated word", "Ada ada ADA", null, ["ada"]],
    ["a one-letter initial is ignored", "A Example", null, ["example"]],
    ["an NHS number with spaces", "999 000 0018", null, "9990000018"],
    ["an NHS number with hyphens", "999-000-0018", null, "9990000018"],
    ["an NHS number typed in full-width digits", "９９９０００００１８", null, "9990000018"],
    ["an NHS number with a wrong check digit", "999 000 0019", "invalid_nhs_number", null],
    [
      "nine digits are a mistyped NHS number, not a text search",
      "999 000 001",
      "invalid_nhs_number",
      null,
    ],
    ["eleven digits are a mistyped NHS number", "99900000181", "invalid_nhs_number", null],
    ["a dotted ten-digit number is refused", "999.000.0018", "invalid_nhs_number", null],
    ["eight digits are a text search", "1234 5678", null, ["1234", "5678"]],
    ["a room number is a text search", "Room 12", null, ["room", "12"]],
  ])("%s", (_label, raw, problem, expected) => {
    const result = normaliseSearchQuery(raw);
    if (problem !== null) {
      expect(result).toMatchObject({ ok: false, problem });
      if (!result.ok) expect(result.message.length).toBeGreaterThan(10);
      return;
    }
    if (!result.ok) throw new Error(result.problem);
    if (typeof expected === "string") {
      expect(result.query).toEqual({ kind: "nhs_number", nhsNumber: expected });
    } else {
      expect(result.query).toMatchObject({ kind: "text", terms: expected });
    }
  });

  it("builds a prefix query and a whole-word query from the terms alone", () => {
    const result = normaliseSearchQuery("Ada Example");
    expect(result).toMatchObject({
      ok: true,
      query: { tsQuery: "ada:* & example:*", exactTsQuery: "ada & example" },
    });
  });

  it("keeps at most the term limit, cuts long terms and says how many were ignored", () => {
    const result = normaliseSearchQuery(
      `one two three four five six seven eight ${"z".repeat(60)}`,
    );
    if (!result.ok || result.query.kind !== "text") throw new Error("expected text");
    expect(result.query.terms).toHaveLength(SEARCH_LIMITS.maxTerms);
    expect(result.query.ignoredTerms).toBe(3);
    const long = normaliseSearchQuery("z".repeat(60));
    expect(long).toMatchObject({
      ok: true,
      query: { terms: ["z".repeat(SEARCH_LIMITS.maxTermLength)] },
    });
  });

  it.each([
    ["apostrophes", "a'".repeat(100)],
    ["separators", `${"-".repeat(199)}!`],
    ["tsquery operators", "ada & !example | (smith) <-> x:* 'quoted'"],
    ["mixed scripts", "Ада アダ Ada"],
  ])("never lets operators into either query (%s)", (_label, raw) => {
    const result = normaliseSearchQuery(raw);
    if (!result.ok || result.query.kind !== "text") return;
    for (const term of result.query.terms) expect(term).toMatch(/^[\p{L}\p{N}]+$/u);
    expect(result.query.tsQuery.split(" & ")).toEqual(result.query.terms.map((t) => `${t}:*`));
    expect(result.query.exactTsQuery.split(" & ")).toEqual(result.query.terms);
  });
});

describe("hazard HZ-011 search plan follows permission and scope", () => {
  it.each<[string, string, string | null, SearchEntityType[], Record<string, string>]>([
    [
      "a care worker",
      "care_worker",
      null,
      ["person", "document", "note"],
      { staff: "not_permitted" },
    ],
    [
      "a Registered Manager",
      "registered_manager",
      NORTH,
      ["person", "staff", "document", "note"],
      {},
    ],
    [
      "an administrator",
      "administrator",
      NORTH,
      ["person", "document"],
      { staff: "not_permitted", note: "not_permitted" },
    ],
    [
      "an HR lead",
      "hr",
      null,
      ["staff"],
      { person: "not_permitted", document: "not_permitted", note: "not_permitted" },
    ],
    [
      "the quality lead",
      "quality_lead",
      null,
      ["person", "document", "note"],
      { staff: "not_permitted" },
    ],
    ["the owner", "owner", null, ["person", "staff", "document", "note"], {}],
    [
      "an agency worker on shift",
      "agency_worker",
      null,
      ["person", "document", "note"],
      { staff: "not_permitted" },
    ],
  ])("%s searches only what the role can read", (_label, role, location, searched, omitted) => {
    const plan = planFor(actor(role, location));
    expect(plan.entities.map((e) => e.type)).toEqual(searched);
    expect(Object.fromEntries(plan.omitted.map((o) => [o.type, o.reason]))).toEqual(omitted);
    expect(plan.matching).toBe("prefix");
  });

  it.each<[string, string, string | null, SearchPlan["personScope"]]>([
    ["assigned people for a care worker", "care_worker", null, { kind: "assigned" }],
    [
      "their locations for a Registered Manager",
      "registered_manager",
      NORTH,
      { kind: "locations", locationIds: [NORTH], teamIds: null, includesAssigned: false },
    ],
    ["everyone for the owner", "owner", null, { kind: "tenant" }],
  ])("person scope is %s", (_label, role, location, scope) => {
    expect(planFor(actor(role, location)).personScope).toEqual(scope);
  });

  it("carries team narrowing for a location-scoped role once teams exist", () => {
    const plan = planFor(actor("team_leader", NORTH, { teamIds: ["team-1"] }));
    expect(plan.personScope).toEqual({
      kind: "locations",
      locationIds: [NORTH],
      teamIds: ["team-1"],
      includesAssigned: false,
    });
  });

  it.each<[string, string, string | null, SearchPlan["staffScope"]]>([
    [
      "location staff for a Registered Manager",
      "registered_manager",
      NORTH,
      { kind: "locations", locationIds: [NORTH] },
    ],
    ["every colleague for HR, whose work is tenant-wide", "hr", null, { kind: "tenant" }],
    ["every colleague for the owner", "owner", null, { kind: "tenant" }],
  ])("staff scope is %s", (_label, role, location, scope) => {
    expect(planFor(actor(role, location)).staffScope).toEqual(scope);
  });

  it("shows identity fields to care roles, and the photo and age (never the date of birth) to an administrator (HZ-001)", () => {
    const care = planFor(actor("care_worker")).entities.find((e) => e.type === "person");
    const admin = planFor(actor("administrator", NORTH)).entities.find((e) => e.type === "person");
    expect(care?.fields).toEqual(expect.arrayContaining(["date_of_birth", "nhs_number", "photo"]));
    expect(admin?.fields).toEqual(expect.arrayContaining(["photo", "age", "room"]));
    expect(admin?.fields).not.toContain("date_of_birth");
    expect(admin?.fields).not.toContain("nhs_number");
  });

  it("matches people by names and room label, or by NHS number alone", () => {
    expect(planFor(actor("care_worker")).entities[0]?.matchFields).toEqual(["names", "room_label"]);
    expect(planFor(actor("care_worker"), "999 000 0018").entities[0]?.matchFields).toEqual([
      "nhs_number",
    ]);
  });

  it.each<[string, string, string | null, string[]]>([
    ["a care worker", "care_worker", null, ["person_document", "care_attachment"]],
    ["an administrator", "administrator", NORTH, ["organisation_document"]],
    ["the owner", "owner", null, ["person_document", "care_attachment", "organisation_document"]],
  ])(
    "%s searches document titles in the categories they can read",
    (_label, role, location, categories) => {
      const plan = planFor(actor(role, location));
      expect(plan.entities.find((e) => e.type === "document")?.documentCategories).toEqual(
        categories,
      );
    },
  );

  it.each<
    [
      string,
      string,
      string | null,
      Partial<SearchActor>,
      Parameters<typeof buildSearchPlan>[0],
      SearchPlanProblem,
    ]
  >([
    [
      "an external professional has no search",
      "external_professional",
      null,
      {},
      { rawQuery: "Ada Example" },
      "not_permitted",
    ],
    [
      "a family member has no search",
      "family_representative",
      null,
      {},
      { rawQuery: "Ada Example" },
      "not_permitted",
    ],
    [
      "a care worker cannot include people who have left",
      "care_worker",
      null,
      {},
      { rawQuery: "Ada Example", includeArchived: true },
      "archived_not_permitted",
    ],
    [
      "a care worker without MFA can search nothing",
      "care_worker",
      null,
      { mfaEnrolled: false },
      { rawQuery: "Ada Example" },
      "mfa_required",
    ],
    [
      "a care worker asking only for staff",
      "care_worker",
      null,
      {},
      { rawQuery: "Ada Example", entityTypes: ["staff"] },
      "nothing_to_search",
    ],
    [
      "an administrator searching an NHS number",
      "administrator",
      NORTH,
      {},
      { rawQuery: "999 000 0018" },
      "nothing_to_search",
    ],
    ["an empty query", "owner", null, {}, { rawQuery: " " }, "empty"],
    [
      "a mistyped NHS number",
      "owner",
      null,
      {},
      { rawQuery: "999 000 0019" },
      "invalid_nhs_number",
    ],
  ])("refuses: %s", (_label, role, location, extra, request, problem) => {
    const result = buildSearchPlan(request, actor(role, location, extra), NOW, RATES);
    expect(result).toMatchObject({ ok: false, problem });
  });

  it("lets HR search colleagues without MFA, because no care record is involved", () => {
    const plan = planFor(actor("hr", null, { mfaEnrolled: false }));
    expect(plan.entities.map((e) => e.type)).toEqual(["staff"]);
  });

  it("leaves care records out for a user without MFA but keeps what needs none", () => {
    const plan = planFor(actor("registered_manager", NORTH, { mfaEnrolled: false }));
    expect(plan.entities.map((e) => e.type)).toEqual(["staff", "document"]);
    expect(plan.entities.find((e) => e.type === "document")?.documentCategories).toEqual([
      "organisation_document",
    ]);
    expect(plan.omitted).toEqual([
      { type: "person", reason: "mfa_required" },
      { type: "note", reason: "mfa_required" },
    ]);
  });

  it("searches only the person for an NHS number, matched exactly", () => {
    const plan = planFor(actor("care_worker"), "999 000 0018");
    expect(plan.query).toEqual({ kind: "nhs_number", nhsNumber: "9990000018" });
    expect(plan.entities.map((e) => e.type)).toEqual(["person"]);
    expect(plan.omitted.every((o) => o.reason === "not_applicable")).toBe(true);
  });

  it("leaves people who have left out unless the user may and does ask (HZ-001)", () => {
    const usual = planFor(actor("registered_manager", NORTH));
    for (const status of SEARCH_CLOSED_PERSON_STATUSES) {
      expect(usual.personStatuses).not.toContain(status);
    }
    expect(usual.personStatuses).toEqual(
      expect.arrayContaining(["enquiry", "pre_admission", "active", "on_leave", "in_hospital"]),
    );
    const archived = planFor(actor("registered_manager", NORTH), "Ada Example", {
      includeArchived: true,
    });
    expect(archived.personStatuses).toEqual(
      expect.arrayContaining([...SEARCH_CLOSED_PERSON_STATUSES]),
    );
    expect(archived.includeArchived).toBe(true);
  });
});

describe("hazard HZ-011 agency access expires at shift end plus 2 hours", () => {
  const agency = (extra: Partial<SearchActor["window"]> = {}) =>
    actor("agency_worker", null, {
      window: { roleEndsAt: null, isAgencyWorker: true, agencyShiftEndsAt: SHIFT_END, ...extra },
    });

  it("ends access the rate-table period after the shift ends", () => {
    const ends = agencyAccessEndsAt(SHIFT_END, RATES);
    expect((ends.getTime() - SHIFT_END.getTime()) / 3_600_000).toBe(RATES.agencyPostShiftHours);
  });

  it.each<[string, Date, boolean]>([
    ["during the shift", new Date("2026-10-11T19:00:00Z"), true],
    ["just after the shift", new Date("2026-10-11T20:30:00Z"), true],
    ["at the end of the post-shift period", agencyAccessEndsAt(SHIFT_END, RATES), false],
    ["the next morning", new Date("2026-10-12T08:00:00Z"), false],
  ])("search %s: %s", (_label, now, allowed) => {
    const result = buildSearchPlan({ rawQuery: "Ada Example" }, agency(), now, RATES);
    if (allowed) {
      expect(result).toMatchObject({
        ok: true,
        plan: { validUntil: agencyAccessEndsAt(SHIFT_END, RATES) },
      });
    } else {
      expect(result).toMatchObject({ ok: false, problem: "access_expired" });
    }
  });

  it("fails closed for an agency worker with no shift recorded", () => {
    const result = buildSearchPlan(
      { rawQuery: "Ada Example" },
      agency({ agencyShiftEndsAt: null }),
      NOW,
      RATES,
    );
    expect(result).toMatchObject({ ok: false, problem: "no_shift_recorded" });
  });

  it("uses the earlier of the role's end and the agency window", () => {
    const roleEndsAt = new Date("2026-10-11T18:00:00Z");
    const plan = planFor(
      agency({ roleEndsAt }),
      "Ada Example",
      {},
      new Date("2026-10-11T17:00:00Z"),
    );
    expect(plan.validUntil).toEqual(roleEndsAt);
  });

  it("shows nothing once the plan's window has passed, even for rows the database returned", () => {
    const plan = planFor(agency(), "Ada Example", {}, new Date("2026-10-11T19:00:00Z"));
    const page = filterSearchResults(
      plan,
      [hit({ assignedToActor: true })],
      new Date("2026-10-12T08:00:00Z"),
    );
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe("hazard HZ-011 break-glass search", () => {
  const fresh = new Date(NOW.getTime() - 60_000);
  const stale = new Date(NOW.getTime() - (STEP_UP_SECONDS + 60) * 1000);
  const reason = "Covering the night shift at South and the resident fell";
  const base: BreakGlassSearchRequest = {
    rawQuery: "Ada Example",
    reason,
    reasonCode: "covering_another_area",
  };
  const who = (
    role: string,
    stepUpAt: Date | null = fresh,
    mfaEnrolled = true,
    searchesInLast24Hours = 0,
  ) => ({ access: accessFor(role, NORTH), stepUpAt, mfaEnrolled, searchesInLast24Hours });
  const plan = (request = base, by = who("registered_manager")) =>
    buildBreakGlassSearchPlan(request, by, NOW, STEP_UP_SECONDS, RATES);

  it("plans a tenant-wide, whole-word, identity-only search for a few people, without where they are", () => {
    const result = plan();
    if (!result.ok) throw new Error(result.problem);
    expect(result.plan).toMatchObject({
      kind: "break_glass",
      matching: "whole_word",
      personScope: { kind: "tenant" },
      pageSize: SEARCH_LIMITS.breakGlassMaxResults,
      breakGlass: { reasonCode: "covering_another_area" },
    });
    const person = result.plan.entities[0];
    expect(result.plan.entities.map((e) => e.type)).toEqual(["person"]);
    expect(person?.fields).toEqual(BREAK_GLASS_RESULT_FIELDS);
    expect(person?.fields).not.toContain("location");
    expect(person?.fields).not.toContain("room");
    expect(person?.matchFields).toEqual(["names"]);
    expect(JSON.stringify(result.plan)).not.toContain(reason);
  });

  it("accepts an NHS number as a specific query", () => {
    expect(plan({ ...base, rawQuery: "999 000 0018" })).toMatchObject({
      ok: true,
      plan: { query: { kind: "nhs_number" }, entities: [{ matchFields: ["nhs_number"] }] },
    });
  });

  it.each<
    [
      string,
      Parameters<typeof buildBreakGlassSearchPlan>[0],
      ReturnType<typeof who>,
      SearchPlanProblem,
    ]
  >([
    ["a care worker has no break-glass", base, who("care_worker"), "not_permitted"],
    ["an external professional has no search", base, who("external_professional"), "not_permitted"],
    ["an old MFA sign-in", base, who("registered_manager", stale), "step_up_required"],
    ["no MFA sign-in at all", base, who("registered_manager", null), "step_up_required"],
    ["no MFA", base, who("registered_manager", fresh, false), "mfa_required"],
    [
      "the daily limit reached",
      base,
      who("registered_manager", fresh, true, RATES.breakGlassSearchMaxPerDay),
      "rate_limited",
    ],
    [
      "no reason code",
      { ...base, reasonCode: null },
      who("registered_manager"),
      "reason_code_required",
    ],
    [
      "an unknown reason code",
      { ...base, reasonCode: "curiosity" },
      who("registered_manager"),
      "reason_code_required",
    ],
    [
      "a short reason",
      { ...base, reason: "Need to look" },
      who("registered_manager"),
      "reason_too_short",
    ],
    [
      "a reason of spaces",
      { ...base, reason: " ".repeat(40) },
      who("registered_manager"),
      "reason_too_short",
    ],
    [
      "a very long reason",
      { ...base, reason: "x".repeat(SEARCH_LIMITS.breakGlassReasonMaxLength + 1) },
      who("registered_manager"),
      "reason_too_long",
    ],
    [
      "one name only",
      { ...base, rawQuery: "Ada" },
      who("registered_manager"),
      "query_not_specific",
    ],
    [
      "a mistyped NHS number",
      { ...base, rawQuery: "999 000 0019" },
      who("registered_manager"),
      "invalid_nhs_number",
    ],
    [
      "a care worker asking for people who have left",
      { ...base, includeArchived: true },
      who("care_worker"),
      "not_permitted",
    ],
  ])("refuses: %s", (_label, request, by, problem) => {
    expect(plan(request, by)).toMatchObject({ ok: false, problem });
  });

  it("allows searches up to the daily limit", () => {
    const below = who("registered_manager", fresh, true, RATES.breakGlassSearchMaxPerDay - 1);
    expect(plan(base, below).ok).toBe(true);
  });

  it("includes people who have left only with the archive permission", () => {
    expect(plan({ ...base, includeArchived: true }, who("deputy_manager"))).toMatchObject({
      ok: true,
      plan: { includeArchived: true },
    });
  });

  it("never shows a prefix match", () => {
    const result = plan();
    if (!result.ok) throw new Error(result.problem);
    const page = filterSearchResults(
      result.plan,
      [hit({ personLocationId: SOUTH }), hit({ personLocationId: SOUTH, matchQuality: "prefix" })],
      NOW,
    );
    expect(page.total).toBe(1);
  });

  it("alerts the Registered Managers of the people's locations and the data protection lead", () => {
    const result = plan();
    if (!result.ok) throw new Error(result.problem);
    const page = filterSearchResults(
      result.plan,
      [
        hit({ personId: "p-1", personLocationId: SOUTH }),
        hit({ personId: "p-2", personLocationId: NORTH }),
      ],
      NOW,
    );
    const alert = breakGlassSearchAlert(page);
    expect(alert).toMatchObject({
      recipientRoleKeys: ["registered_manager", "data_protection_lead"],
      locationIds: [NORTH, SOUTH].sort(),
      personIds: ["p-1", "p-2"],
    });
    expect(alert.title).not.toMatch(/Example|Ada/);
    expect(breakGlassSearchAlert(null, true)).toMatchObject({
      title: "Break-glass search limit reached",
      locationIds: [],
      personIds: [],
    });
  });
});

describe("hazard HZ-011 search results and counts stay in scope", () => {
  const manager = () => planFor(actor("registered_manager", NORTH));

  it.each<[string, Partial<SearchHit>, boolean]>([
    ["a person at the manager's location", {}, true],
    ["a person at another location", { personLocationId: SOUTH }, false],
    [
      "a person elsewhere the manager is assigned to (a location role never counts assignments, S-M1)",
      { personLocationId: SOUTH, assignedToActor: true },
      false,
    ],
    ["a discharged person (not asked for)", { personStatus: "discharged" }, false],
    ["a person with no location", { personLocationId: null }, false],
    ["a person-scoped row without a person", { personId: null }, false],
    ["a person-scoped row without a status", { personStatus: null }, false],
    ["a prefix match in an ordinary search", { matchQuality: "prefix" }, true],
    ["a note at the location", { entityType: "note" }, true],
    ["a note replaced by a correction", { entityType: "note", superseded: true }, false],
    [
      "a letter about a person",
      { entityType: "document", documentCategory: "person_document" },
      true,
    ],
    [
      "a photo (never searched by title)",
      { entityType: "document", documentCategory: "person_photo" },
      false,
    ],
    [
      "an unknown document category",
      { entityType: "document", documentCategory: "something_else" },
      false,
    ],
    ["a document without a category", { entityType: "document", documentCategory: null }, false],
    [
      "a policy",
      {
        entityType: "document",
        documentCategory: "organisation_document",
        personId: null,
        personStatus: null,
        personLocationId: null,
      },
      true,
    ],
    [
      "a policy wrongly tied to a person",
      { entityType: "document", documentCategory: "organisation_document" },
      false,
    ],
    [
      "a colleague at the location",
      { entityType: "staff", personId: null, staffLocationIds: [NORTH] },
      true,
    ],
    [
      "a colleague who works tenant-wide",
      { entityType: "staff", personId: null, staffLocationIds: null },
      true,
    ],
    [
      "a colleague only at another location",
      { entityType: "staff", personId: null, staffLocationIds: [SOUTH] },
      false,
    ],
  ])("%s: shown %s", (_label, extra, shown) => {
    const page = filterSearchResults(manager(), [hit(extra)], NOW);
    expect(page.total).toBe(shown ? 1 : 0);
    expect(page.droppedByPlan).toBe(shown ? 0 : 1);
  });

  it("shows a care worker only the people assigned to them", () => {
    const plan = planFor(actor("care_worker"));
    const page = filterSearchResults(
      plan,
      [
        hit({ assignedToActor: true }),
        hit({ assignedToActor: false }),
        hit({ entityType: "staff", personId: null }),
      ],
      NOW,
    );
    expect(page.total).toBe(1);
    expect(page.counts).toEqual({ person: 1, staff: 0, document: 0, note: 0 });
  });

  it("narrows to the user's teams when teams are set", () => {
    const plan = planFor(actor("team_leader", NORTH, { teamIds: ["team-1"] }));
    const page = filterSearchResults(
      plan,
      [hit({ personTeamIds: ["team-1"] }), hit({ personTeamIds: ["team-2"] }), hit({})],
      NOW,
    );
    expect(page.total).toBe(1);
  });

  it("makes an out-of-scope match look exactly like no match at all", () => {
    const plan = planFor(actor("care_worker"), "999 000 0018");
    const outOfScope = filterSearchResults(plan, [hit({ assignedToActor: false })], NOW);
    const nothing = filterSearchResults(plan, [], NOW);
    const { droppedByPlan: _alarm, ...shown } = outOfScope;
    const { droppedByPlan: _none, ...empty } = nothing;
    expect(shown).toEqual(empty);
    expect(outOfScope.droppedByPlan).toBe(1);
  });

  it("counts by kind over visible rows only and pages after ordering", () => {
    const plan = manager();
    const rows = [
      ...Array.from({ length: 27 }, (_, i) => hit({ rank: i })),
      hit({ entityType: "note", rank: 100 }),
      hit({ personLocationId: SOUTH, rank: 1000 }),
    ];
    const page = filterSearchResults(plan, rows, NOW);
    expect(page.counts).toEqual({ person: 27, staff: 0, document: 0, note: 1 });
    expect(page.total).toBe(28);
    expect(page.items).toHaveLength(SEARCH_LIMITS.pageSize);
    expect(page.hasMore).toBe(true);
    expect(page.items.every((h) => h.entityType === "person")).toBe(true);
    expect(page.droppedByPlan).toBe(1);
  });

  it("shows people who have left only on an archive search", () => {
    const plan = planFor(actor("registered_manager", NORTH), "Ada Example", {
      includeArchived: true,
    });
    const statuses: PersonStatus[] = [
      "discharged",
      "deceased",
      "archived",
      "not_admitted",
      "active",
    ];
    const page = filterSearchResults(
      plan,
      statuses.map((personStatus) => hit({ personStatus })),
      NOW,
    );
    expect(page.total).toBe(statuses.length);
    expect(page.items[0]?.personStatus).toBe("active");
  });

  it("lets a break-glass search find a person outside scope, and nothing else", () => {
    const result = buildBreakGlassSearchPlan(
      {
        rawQuery: "Ada Example",
        reason: "Covering the night shift at South tonight",
        reasonCode: "covering_another_area",
      },
      {
        access: accessFor("registered_manager", NORTH),
        stepUpAt: NOW,
        mfaEnrolled: true,
        searchesInLast24Hours: 0,
      },
      NOW,
      STEP_UP_SECONDS,
      RATES,
    );
    if (!result.ok) throw new Error(result.problem);
    const page = filterSearchResults(
      result.plan,
      [hit({ personLocationId: SOUTH }), hit({ entityType: "note", personLocationId: SOUTH })],
      NOW,
    );
    expect(page.total).toBe(1);
    expect(page.items[0]?.entityType).toBe("person");
  });
});

describe("hazard HZ-011 each kind of record is searched in the scope of its own permission (ADR-0071)", () => {
  const role = (roleKey: string, locationId: string | null) => {
    const found = builtinRole(roleKey);
    if (!found) throw new Error(`unknown role ${roleKey}`);
    return {
      roleKey,
      scopeKind: found.scopeKind,
      permissions: found.permissions,
      locationId,
      organisationWide: false,
      validFrom: PAST,
      validTo: null,
    };
  };
  const financeViewer = {
    roleKey: "tenant_finance_viewer",
    scopeKind: "tenant" as const,
    permissions: ["finance.reporting.read"],
    locationId: null,
    organisationWide: false,
    validFrom: PAST,
    validTo: null,
  };
  const withAccess = (access: EffectiveAccess): SearchActor => ({
    ...actor("care_worker"),
    access,
  });

  it("keeps a team leader at North who also views finance everywhere to North", () => {
    const plan = planFor(
      withAccess(resolveAccess([role("team_leader", NORTH), financeViewer], [], NOW)),
    );
    expect(plan.personScope).toEqual({
      kind: "locations",
      locationIds: [NORTH],
      teamIds: null,
      includesAssigned: false,
    });
    const page = filterSearchResults(
      plan,
      [
        hit({ personLocationId: NORTH }),
        hit({ personLocationId: SOUTH }),
        hit({ entityType: "note", personLocationId: SOUTH }),
      ],
      NOW,
    );
    expect(page.items.map((h) => h.personLocationId)).toEqual([NORTH]);
  });

  it("holds people and notes each to their own permission's scope", () => {
    // An administrator at North (names and rooms there) given notes at South by an acting-up grant.
    const access = resolveAccess(
      [role("administrator", NORTH)],
      [
        {
          permissions: ["care.note.read"],
          locationId: SOUTH,
          organisationWide: false,
          validFrom: PAST,
          validTo: new Date("2027-01-01T00:00:00Z"),
          revokedAt: null,
        },
      ],
      NOW,
    );
    const plan = planFor(withAccess(access));
    const scopes = Object.fromEntries(plan.entities.map((e) => [e.type, e.personScope]));
    expect(scopes.person).toEqual({
      kind: "locations",
      locationIds: [NORTH],
      teamIds: null,
      includesAssigned: false,
    });
    expect(scopes.note).toEqual({
      kind: "locations",
      locationIds: [SOUTH],
      teamIds: null,
      includesAssigned: false,
    });
    // The search runs over both; each result is held to its own kind's scope.
    expect(plan.personScope).toEqual({
      kind: "locations",
      locationIds: [NORTH, SOUTH].sort(),
      teamIds: null,
      includesAssigned: false,
    });
    const shown = filterSearchResults(
      plan,
      [
        hit({ personLocationId: NORTH }),
        hit({ personLocationId: SOUTH }),
        hit({ entityType: "note", personLocationId: NORTH }),
        hit({ entityType: "note", personLocationId: SOUTH }),
      ],
      NOW,
    ).items.map((h) => `${h.entityType}@${h.personLocationId === NORTH ? "north" : "south"}`);
    expect(shown.sort()).toEqual(["note@south", "person@north"]);
  });

  it("holds each document category to its own permission's scope", () => {
    // A Registered Manager at North given care notes at South: letters at North, attachments at both.
    const access = resolveAccess(
      [role("registered_manager", NORTH)],
      [
        {
          permissions: ["care.note.read"],
          locationId: SOUTH,
          organisationWide: false,
          validFrom: PAST,
          validTo: new Date("2027-01-01T00:00:00Z"),
          revokedAt: null,
        },
      ],
      NOW,
    );
    const plan = planFor(withAccess(access), "Ada Example", { entityTypes: ["document"] });
    const shown = filterSearchResults(
      plan,
      [NORTH, SOUTH].flatMap((personLocationId) =>
        (["person_document", "care_attachment"] as const).map((documentCategory) =>
          hit({ entityType: "document", documentCategory, personLocationId }),
        ),
      ),
      NOW,
    ).items.map((h) => `${h.documentCategory}@${h.personLocationId === NORTH ? "north" : "south"}`);
    expect(shown.sort()).toEqual([
      "care_attachment@north",
      "care_attachment@south",
      "person_document@north",
    ]);
  });

  it("searches colleagues only where a staff-search permission reaches", () => {
    const plan = planFor(
      withAccess(resolveAccess([role("team_leader", NORTH), financeViewer], [], NOW)),
    );
    expect(plan.staffScope).toEqual({ kind: "locations", locationIds: [NORTH] });
  });

  it("counts the people assigned to the user only for a permission an assigned-scope role carries (S-M1)", () => {
    const elsewhere = hit({ personLocationId: SOUTH, assignedToActor: true });
    const careWorkerAndLead = planFor(
      withAccess(resolveAccess([role("care_worker", null), role("team_leader", NORTH)], [], NOW)),
    );
    expect(filterSearchResults(careWorkerAndLead, [elsewhere], NOW).total).toBe(1);
    const leadAndFinance = planFor(
      withAccess(resolveAccess([role("team_leader", NORTH), financeViewer], [], NOW)),
    );
    expect(filterSearchResults(leadAndFinance, [elsewhere], NOW).total).toBe(0);
  });
});

describe("hazard HZ-001 search ranking puts the right person first", () => {
  const order = (rows: SearchHit[]) => [...rows].sort(compareSearchHits).map((h) => h.id);

  it.each<[string, Partial<SearchHit>, Partial<SearchHit>]>([
    [
      "a person before a note, whatever the relevance",
      { id: "a", entityType: "person", rank: 0 },
      { id: "b", entityType: "note", rank: 99 },
    ],
    ["a person before a colleague", { id: "a" }, { id: "b", entityType: "staff", personId: null }],
    [
      "a colleague before a document",
      { id: "a", entityType: "staff", personId: null },
      { id: "b", entityType: "document" },
    ],
    [
      "a whole-word match before a prefix match",
      { id: "a", matchQuality: "exact", rank: 0 },
      { id: "b", matchQuality: "prefix", rank: 99 },
    ],
    [
      "a current resident before one who left",
      { id: "a", personStatus: "active", sortName: "Zed Example" },
      { id: "b", personStatus: "discharged", sortName: "Ada Example" },
    ],
    [
      "a resident before someone being assessed",
      { id: "a", personStatus: "in_hospital" },
      { id: "b", personStatus: "pre_admission" },
    ],
    [
      "by name when the status is the same",
      { id: "a", sortName: "ada example" },
      { id: "b", sortName: "Bea Example" },
    ],
    [
      "by date of birth when the name is the same",
      { id: "a", sortName: "Ada Example", dateOfBirth: "1938-05-01" },
      { id: "b", sortName: "Ada Example", dateOfBirth: "1941-02-03" },
    ],
    [
      "by relevance when everything else is the same",
      { id: "b", sortName: "Ada Example", rank: 5 },
      { id: "a", sortName: "Ada Example", rank: 1 },
    ],
    [
      "by id last, so pages are stable",
      { id: "a", sortName: "Ada Example" },
      { id: "b", sortName: "Ada Example" },
    ],
  ])("ranks %s", (_label, first, second) => {
    const a = hit(first);
    const b = hit(second);
    expect(order([b, a])).toEqual([a.id, b.id]);
  });

  it("warns when two people in the results share a name, compared as the index compares names", () => {
    const rows = [
      hit({ personId: "p-1", sortName: "Ada O'Example" }),
      hit({ personId: "p-2", sortName: "ADA OEXAMPLE" }),
      hit({ personId: "p-3", sortName: "Bea Example" }),
      hit({ entityType: "note", personId: "p-3", sortName: "Bea Example" }),
      hit({ personId: "p-4", sortName: null }),
    ];
    expect(sameNameWarnings(rows)).toEqual([{ kind: "same_name", personIds: ["p-1", "p-2"] }]);
    const page = filterSearchResults(planFor(actor("registered_manager", NORTH)), rows, NOW);
    expect(page.warnings).toEqual([{ kind: "same_name", personIds: ["p-1", "p-2"] }]);
  });

  it("gives no warning for one person found twice", () => {
    expect(
      sameNameWarnings([
        hit({ personId: "p-1", sortName: "Ada Example" }),
        hit({ personId: "p-1", sortName: "Ada Example" }),
      ]),
    ).toEqual([]);
  });
});

describe("hazard HZ-011 search audit events record what was shown, never the words typed", () => {
  it.each([
    ["a name", "Ada Example", ["ada", "example"]],
    ["a name with an apostrophe", "Bea O'Example", ["bea", "oexample", "o'example"]],
    ["an NHS number", "999 000 0018", ["9990000018", "999 000 0018"]],
  ])("records ids, scope and counts, not the query: %s", (_label, raw, forbidden) => {
    const plan = planFor(actor("registered_manager", NORTH), raw);
    const page = filterSearchResults(
      plan,
      [hit({ id: "r-1", personId: "p-9", sortName: "Person Nine" })],
      NOW,
    );
    const event = searchAuditEvent(plan, page);
    expect(event).toMatchObject({
      action: "platform.search.run",
      outcome: "success",
      resourceType: "search",
      reason: null,
      scope: {
        total: 1,
        includeArchived: false,
        personScope: "locations",
        locationIds: [NORTH],
        validUntil: null,
        personIds: ["p-9"],
        careRecordView: true,
        resultIds: { person: ["r-1"], staff: [], document: [], note: [] },
      },
    });
    const stored = JSON.stringify(event).toLowerCase();
    for (const word of forbidden) expect(stored).not.toContain(word);
  });

  it("records when an agency worker's access ends", () => {
    const plan = planFor(actor("agency_worker"), "Ada Example");
    const event = searchAuditEvent(plan, filterSearchResults(plan, [], NOW));
    expect(event.scope.validUntil).toBe(agencyAccessEndsAt(SHIFT_END, RATES).toISOString());
    expect(event.scope.careRecordView).toBe(false);
  });

  it("refers to the break-glass record for the reason instead of copying it", () => {
    const reason = "Resident from South arrived at North during the night";
    const result = buildBreakGlassSearchPlan(
      { rawQuery: "Ada Example", reason, reasonCode: "emergency_care" },
      {
        access: accessFor("registered_manager", NORTH),
        stepUpAt: NOW,
        mfaEnrolled: true,
        searchesInLast24Hours: 0,
      },
      NOW,
      STEP_UP_SECONDS,
      RATES,
    );
    if (!result.ok) throw new Error(result.problem);
    const page = filterSearchResults(
      result.plan,
      [hit({ personId: "p-77", personLocationId: SOUTH })],
      NOW,
    );
    expect(() => searchAuditEvent(result.plan, page)).toThrow(RangeError);
    const event = searchAuditEvent(result.plan, page, { breakGlassRecordId: "bg-1" });
    expect(event).toMatchObject({
      action: "platform.search.break_glass",
      reason: null,
      scope: {
        personIds: ["p-77"],
        breakGlassRecordId: "bg-1",
        reasonCode: "emergency_care",
        personScope: "tenant",
        termCount: 2,
        queryKind: "text",
      },
    });
    const stored = JSON.stringify(event);
    expect(stored).not.toContain("Resident from South");
    expect(stored.toLowerCase()).not.toContain("example");
  });

  it("records a refusal with the problem and no query", () => {
    expect(searchRefusalAuditEvent("archived_not_permitted", ["person"])).toEqual({
      action: "platform.search.refused",
      outcome: "denied",
      resourceType: "search",
      reason: null,
      scope: {
        queryKind: null,
        termCount: 0,
        entityTypes: ["person"],
        omitted: [],
        includeArchived: false,
        personScope: null,
        locationIds: [],
        validUntil: null,
        resultCounts: null,
        total: 0,
        resultIds: null,
        personIds: [],
        careRecordView: false,
        problem: "archived_not_permitted",
      },
    });
    expect(searchRefusalAuditEvent("not_permitted").scope.entityTypes).toHaveLength(4);
  });
});
