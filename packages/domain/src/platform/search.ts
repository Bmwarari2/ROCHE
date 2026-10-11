import { BREAK_GLASS_REASON_CODES, type BreakGlassReasonCode } from "../people/break-glass-report";
import { PERSON_STATUSES, type PersonStatus } from "../people/lifecycle";
import { validateNhsNumber } from "../people/nhs-number";
import { authorise, can, type EffectiveAccess } from "./access";
import type { DocumentCategoryKey } from "./documents";
import { type Permission, touchesCareRecords } from "./permissions";
import type { PlatformRates } from "./rates";

/**
 * Permission-aware, tenant-scoped search (master prompt section 9.1; platform-completions.md
 * rules 1 to 9; hazards HZ-001 and HZ-011; ADR-0070). Pure rules for the API and the device:
 *
 * - `normaliseSearchQuery` turns what was typed into bounded terms in linear time, with no regular
 *   expression run over the user's text (CodeQL fails the build on polynomial ReDoS), and spots an
 *   NHS number, which must pass its check digit and is matched exactly, never by prefix.
 * - `buildSearchPlan` decides which kinds of record the user may search and the scope they are
 *   searched in, from the user's permissions and attribute scope (locations, teams, assigned
 *   people, the time window and agency access ending at shift end plus a rate-table period).
 * - `buildBreakGlassSearchPlan` is the separate path for finding a person outside scope: it needs
 *   break-glass permission, an MFA sign-in within the step-up window, a reason code and a typed
 *   reason; it matches whole name words only, withholds location and room, is rate-limited and
 *   alerts the Registered Manager and the data protection lead.
 * - `filterSearchResults` applies the plan again to whatever the database returned (defence in
 *   depth behind row-level security), ranks people first and exact matches first, warns when two
 *   people share a name, and counts only what the user may see.
 * - `searchAuditEvent` records the opaque ids shown, which count as care-record views, never the
 *   words typed, which are often a person's name.
 */

/** Bounds on what a search accepts. Input validation limits, not policy or statutory figures. */
export const SEARCH_LIMITS = {
  /** Characters accepted at all; anything longer is refused before any other work. */
  maxQueryLength: 200,
  maxTerms: 6,
  minTermLength: 2,
  maxTermLength: 40,
  pageSize: 25,
  breakGlassMaxResults: 10,
  /** The same minimum as the break-glass justification (`BreakGlassRequest` in contracts). */
  breakGlassReasonMinLength: 20,
  breakGlassReasonMaxLength: 1000,
} as const;

export const SEARCH_ENTITY_TYPES = ["person", "staff", "document", "note"] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/**
 * People whose care with the service has ended. They are left out of search unless the user holds
 * `platform.search.archived` and asks for them, so a current resident is not confused with a
 * former one of the same name (HZ-001).
 */
export const SEARCH_CLOSED_PERSON_STATUSES: readonly PersonStatus[] = [
  "discharged",
  "deceased",
  "archived",
  "not_admitted",
];

export const SEARCH_OPEN_PERSON_STATUSES: readonly PersonStatus[] = PERSON_STATUSES.filter(
  (s) => !SEARCH_CLOSED_PERSON_STATUSES.includes(s),
);

// ------------------------------------------------------------------------------------------------
// Query normalisation
// ------------------------------------------------------------------------------------------------

/** Tested on one character at a time, so the cost is linear in the (bounded) input. */
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const COMBINING_MARK = /^\p{M}$/u;
/** Apostrophes inside a name join it ("O'Brien" is one term, "obrien"), as in the index. */
const JOINERS = new Set(["'", "’", "ʼ"]);
/** Letters that compatibility decomposition leaves alone; mapped as Postgres `unaccent` does. */
const FOLDED: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

/**
 * The search terms in some text, exactly as the index stores them: lower case, accents removed,
 * apostrophes joined, everything else a separator. The schema step's `app.search_terms` SQL
 * function must give the same terms for the same text (platform-completions.md rule 2).
 */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  let current = "";
  for (const ch of text.toLowerCase().normalize("NFKD")) {
    if (COMBINING_MARK.test(ch) || JOINERS.has(ch)) continue;
    const folded = FOLDED[ch];
    if (folded !== undefined) {
      current += folded;
    } else if (LETTER_OR_DIGIT.test(ch)) {
      current += ch;
    } else if (current) {
      terms.push(current);
      current = "";
    }
  }
  if (current) terms.push(current);
  return terms;
}

export type NormalisedSearchQuery =
  | {
      readonly kind: "text";
      readonly terms: readonly string[];
      /** Prefix query for `to_tsquery('harbour_search', $1)`, always as a bound parameter. */
      readonly tsQuery: string;
      /** Whole-word query (no prefixes): break-glass search, and exact matches ranked first. */
      readonly exactTsQuery: string;
      /** Terms dropped as too short or beyond the limit, so the screen can say so. */
      readonly ignoredTerms: number;
    }
  | { readonly kind: "nhs_number"; readonly nhsNumber: string };

export type SearchQueryProblem = "empty" | "too_long" | "too_short" | "invalid_nhs_number";

export type SearchQueryCheck =
  | { readonly ok: true; readonly query: NormalisedSearchQuery }
  | { readonly ok: false; readonly problem: SearchQueryProblem; readonly message: string };

const QUERY_MESSAGES: Record<SearchQueryProblem, string> = {
  empty: "Type a name, a word or an NHS number to search for.",
  too_long: `Search for ${SEARCH_LIMITS.maxQueryLength} characters or fewer.`,
  too_short: `Type at least ${SEARCH_LIMITS.minTermLength} letters or numbers.`,
  invalid_nhs_number: "This is not a valid NHS number. Check the 10 digits and try again.",
};

/**
 * The shape of an attempted NHS number: digits with spaces, hyphens or dots between them, and 9 to
 * 11 digits. Only exactly 10 digits without dots can be valid; the rest are near misses that are
 * refused with the NHS number message rather than searched as text (HZ-001).
 */
function nhsNumberAttempt(text: string): "none" | "candidate" | "malformed" {
  let digits = 0;
  let dotted = false;
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") digits += 1;
    else if (ch === ".") dotted = true;
    else if (ch !== " " && ch !== "-") return "none";
  }
  if (digits < 9 || digits > 11) return "none";
  return digits === 10 && !dotted ? "candidate" : "malformed";
}

export function normaliseSearchQuery(raw: string): SearchQueryCheck {
  const fail = (problem: SearchQueryProblem): SearchQueryCheck => ({
    ok: false,
    problem,
    message: QUERY_MESSAGES[problem],
  });
  if (raw.length > SEARCH_LIMITS.maxQueryLength) return fail("too_long");
  const text = raw.normalize("NFKC").trim();
  if (text.length === 0) return fail("empty");

  const attempt = nhsNumberAttempt(text);
  if (attempt === "malformed") return fail("invalid_nhs_number");
  if (attempt === "candidate") {
    const nhs = validateNhsNumber(text);
    // A mistyped number never falls back to a near match: the wrong person is worse than none.
    if (!nhs.valid) return fail("invalid_nhs_number");
    return { ok: true, query: { kind: "nhs_number", nhsNumber: nhs.value } };
  }

  const all = searchTerms(text);
  const terms: string[] = [];
  let ignored = 0;
  for (const term of all) {
    if (term.length < SEARCH_LIMITS.minTermLength || terms.length >= SEARCH_LIMITS.maxTerms) {
      ignored += 1;
      continue;
    }
    const bounded = term.slice(0, SEARCH_LIMITS.maxTermLength);
    if (terms.includes(bounded)) continue;
    terms.push(bounded);
  }
  if (terms.length === 0) return fail("too_short");
  return {
    ok: true,
    query: {
      kind: "text",
      terms,
      tsQuery: terms.map((t) => `${t}:*`).join(" & "),
      exactTsQuery: terms.join(" & "),
      ignoredTerms: ignored,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Search plan
// ------------------------------------------------------------------------------------------------

/** Whom person-based records (people, their documents and notes) are searched among. */
export type SearchPersonScope =
  | { readonly kind: "tenant" }
  | {
      readonly kind: "locations";
      readonly locationIds: readonly string[];
      /** Team narrowing arrives with rotas (Phase 2); null means no team restriction. */
      readonly teamIds: readonly string[] | null;
    }
  | { readonly kind: "assigned" };

export type SearchStaffScope =
  | { readonly kind: "tenant" }
  | { readonly kind: "locations"; readonly locationIds: readonly string[] };

/** Which person fields the query is matched against. */
export type PersonMatchField = "names" | "room_label" | "nhs_number";

export interface SearchPlanEntity {
  readonly type: SearchEntityType;
  /** The permission the entity's results rest on. */
  readonly permission: Permission;
  /** The fields a result may show. */
  readonly fields: readonly string[];
  readonly personScoped: boolean;
  /** Needs MFA (care record permissions, section 5.3). */
  readonly careRecord: boolean;
  /** For documents: the categories searched (titles and display file names only). */
  readonly documentCategories?: readonly DocumentCategoryKey[];
  /** For people: the fields matched. */
  readonly matchFields?: readonly PersonMatchField[];
}

export type SearchOmissionReason = "not_permitted" | "no_scope" | "mfa_required" | "not_applicable";

export interface SearchPlan {
  readonly kind: "scoped" | "break_glass";
  readonly query: NormalisedSearchQuery;
  /** Prefix matching for ordinary search; whole name words only for break-glass search. */
  readonly matching: "prefix" | "whole_word";
  readonly entities: readonly SearchPlanEntity[];
  /** Asked for but not searched, with why; says nothing about any record. */
  readonly omitted: readonly {
    readonly type: SearchEntityType;
    readonly reason: SearchOmissionReason;
  }[];
  readonly personScope: SearchPersonScope | null;
  readonly staffScope: SearchStaffScope | null;
  readonly personStatuses: readonly PersonStatus[];
  readonly includeArchived: boolean;
  /** When the user's access ends (role expiry or agency shift end plus the post-shift period). */
  readonly validUntil: Date | null;
  readonly pageSize: number;
  readonly breakGlass: { readonly reasonCode: BreakGlassReasonCode } | null;
}

export type SearchPlanProblem =
  | SearchQueryProblem
  | "not_permitted"
  | "archived_not_permitted"
  | "access_expired"
  | "no_shift_recorded"
  | "mfa_required"
  | "nothing_to_search"
  | "step_up_required"
  | "reason_too_short"
  | "reason_too_long"
  | "reason_code_required"
  | "query_not_specific"
  | "rate_limited";

export type SearchPlanCheck =
  | { readonly ok: true; readonly plan: SearchPlan }
  | { readonly ok: false; readonly problem: SearchPlanProblem; readonly message: string };

const PLAN_MESSAGES: Record<Exclude<SearchPlanProblem, SearchQueryProblem>, string> = {
  not_permitted: "Your role does not include search.",
  archived_not_permitted:
    "Your role cannot search people who have left the service. Ask your manager if you need a past record.",
  access_expired: "Your access has ended. Sign in again if you are on shift.",
  no_shift_recorded:
    "No shift is recorded for you today, so search is not available. Ask the person in charge.",
  mfa_required:
    "Set up a second sign-in step (an authenticator app or a passkey) to search records.",
  nothing_to_search: "Your role cannot search any of the kinds of record you chose.",
  step_up_required: "Sign in again with your second step to search outside your usual access.",
  reason_too_short: `Explain why you need to find this person (${SEARCH_LIMITS.breakGlassReasonMinLength} characters or more).`,
  reason_too_long: `Keep the reason to ${SEARCH_LIMITS.breakGlassReasonMaxLength} characters or fewer.`,
  reason_code_required: "Choose the reason that fits best.",
  query_not_specific:
    "Search outside your usual access by full name (first and last) or by NHS number.",
  rate_limited:
    "You have made the most break-glass searches allowed in 24 hours. The data protection lead has been told.",
};

function planFail(problem: SearchPlanProblem): SearchPlanCheck {
  const message =
    problem in PLAN_MESSAGES
      ? PLAN_MESSAGES[problem as Exclude<SearchPlanProblem, SearchQueryProblem>]
      : QUERY_MESSAGES[problem as SearchQueryProblem];
  return { ok: false, problem, message };
}

/** Fields that identify a person beyond doubt before their record is opened (HZ-001). */
export const PERSON_IDENTITY_FIELDS = [
  "name",
  "preferred_name",
  "date_of_birth",
  "nhs_number",
  "photo",
  "location",
  "room",
  "status",
] as const;
/**
 * What a names-and-rooms role (`people.demographics.read`) sees. These roles record visitors,
 * moves and incidents, so they get the photo and the age (not the date of birth) to tell two
 * people apart, and the same-name warning (HZ-001).
 */
export const PERSON_DEMOGRAPHIC_FIELDS = [
  "name",
  "preferred_name",
  "photo",
  "age",
  "location",
  "room",
  "status",
] as const;
/**
 * What a break-glass search shows before the record is opened: enough to confirm identity, and
 * never where the person is (location and room appear only after the alerting open step).
 */
export const BREAK_GLASS_RESULT_FIELDS = [
  "name",
  "preferred_name",
  "date_of_birth",
  "nhs_number",
  "photo",
  "status",
] as const;

/** Any of these lets a user find colleagues (to assign, invite, train or supervise them). */
export const STAFF_SEARCH_PERMISSIONS: readonly Permission[] = [
  "platform.user.manage",
  "platform.task.manage",
  "people.assignment.manage",
  "workforce.recruitment.manage",
  "workforce.training.manage",
  "workforce.supervision.manage",
  "workforce.casework.manage",
];
/** HR functions are tenant-wide (master prompt section 4), so these widen staff scope. */
const TENANT_WIDE_STAFF_PERMISSIONS: readonly Permission[] = [
  "workforce.recruitment.manage",
  "workforce.training.manage",
  "workforce.supervision.manage",
  "workforce.casework.manage",
];

/** Document categories searchable by title, with the permission each rests on. */
export const SEARCHABLE_DOCUMENT_CATEGORIES: readonly {
  readonly category: DocumentCategoryKey;
  readonly permission: Permission;
  readonly personScoped: boolean;
}[] = [
  { category: "person_document", permission: "people.person.read", personScoped: true },
  { category: "care_attachment", permission: "care.note.read", personScoped: true },
  {
    category: "organisation_document",
    permission: "platform.document.manage",
    personScoped: false,
  },
];

/** When agency access ends: shift end plus the rate-table period (master prompt section 4). */
export function agencyAccessEndsAt(
  shiftEndsAt: Date,
  rates: Pick<PlatformRates, "agencyPostShiftHours">,
): Date {
  return new Date(shiftEndsAt.getTime() + rates.agencyPostShiftHours * 3_600_000);
}

export interface SearchAccessWindow {
  /** The end of the time-boxed role (external professionals, agency, inspectors), if any. */
  readonly roleEndsAt: Date | null;
  /** Agency and bank workers: their access follows the shift they are working. */
  readonly isAgencyWorker: boolean;
  /** For agency and bank workers: the end of the shift they are working; null when none. */
  readonly agencyShiftEndsAt: Date | null;
}

function accessValidUntil(
  window: SearchAccessWindow,
  rates: Pick<PlatformRates, "agencyPostShiftHours">,
): Date | null {
  const ends = [
    window.roleEndsAt,
    window.agencyShiftEndsAt ? agencyAccessEndsAt(window.agencyShiftEndsAt, rates) : null,
  ].filter((d): d is Date => d !== null);
  if (ends.length === 0) return null;
  return new Date(Math.min(...ends.map((d) => d.getTime())));
}

function personScopeFor(access: EffectiveAccess, teamIds: readonly string[] | null) {
  switch (access.scope) {
    case "tenant":
      return { kind: "tenant" } as const;
    case "locations":
      return { kind: "locations", locationIds: access.locationIds, teamIds } as const;
    case "assigned":
      return { kind: "assigned" } as const;
    case "none":
      return null;
  }
}

/**
 * Colleagues are searched tenant-wide by tenant-scoped roles and by HR roles (no person scope,
 * tenant-wide workforce duties), and at their own locations by location-scoped roles.
 */
function staffScopeFor(access: EffectiveAccess): SearchStaffScope | null {
  if (access.scope === "tenant") return { kind: "tenant" };
  if (access.scope === "locations") return { kind: "locations", locationIds: access.locationIds };
  if (TENANT_WIDE_STAFF_PERMISSIONS.some((p) => can(access, p))) return { kind: "tenant" };
  return null;
}

export interface SearchRequest {
  readonly rawQuery: string;
  /** Kinds of record asked for; every kind when omitted. */
  readonly entityTypes?: readonly SearchEntityType[];
  readonly includeArchived?: boolean;
}

export interface SearchActor {
  readonly access: EffectiveAccess;
  readonly mfaEnrolled: boolean;
  readonly window: SearchAccessWindow;
  /** Team narrowing for location-scoped roles (Phase 2); null until rotas define teams. */
  readonly teamIds?: readonly string[] | null;
}

type EntityDecision =
  | { readonly entity: SearchPlanEntity }
  | { readonly omitted: SearchOmissionReason };

function decideEntity(
  type: SearchEntityType,
  actor: SearchActor,
  query: NormalisedSearchQuery,
): EntityDecision {
  const { access } = actor;
  const personScope = personScopeFor(access, actor.teamIds ?? null);
  const withMfa = (entity: SearchPlanEntity): EntityDecision =>
    entity.careRecord && !actor.mfaEnrolled ? { omitted: "mfa_required" } : { entity };

  if (query.kind === "nhs_number" && type !== "person") return { omitted: "not_applicable" };

  switch (type) {
    case "person": {
      const full = can(access, "people.person.read");
      const names = can(access, "people.demographics.read");
      if (!full && !(names && query.kind === "text")) return { omitted: "not_permitted" };
      if (!personScope) return { omitted: "no_scope" };
      const permission: Permission = full ? "people.person.read" : "people.demographics.read";
      return withMfa({
        type,
        permission,
        fields: full ? PERSON_IDENTITY_FIELDS : PERSON_DEMOGRAPHIC_FIELDS,
        personScoped: true,
        careRecord: touchesCareRecords(permission),
        matchFields: query.kind === "nhs_number" ? ["nhs_number"] : ["names", "room_label"],
      });
    }
    case "staff": {
      const permission = STAFF_SEARCH_PERMISSIONS.find((p) => can(access, p));
      if (!permission) return { omitted: "not_permitted" };
      if (!staffScopeFor(access)) return { omitted: "no_scope" };
      return withMfa({
        type,
        permission,
        fields: ["name", "roles", "locations"],
        personScoped: false,
        careRecord: false,
      });
    }
    case "document": {
      const allowed = SEARCHABLE_DOCUMENT_CATEGORIES.filter(
        (c) =>
          can(access, c.permission) &&
          (!c.personScoped || personScope !== null) &&
          (!touchesCareRecords(c.permission) || actor.mfaEnrolled),
      );
      if (allowed.length === 0) {
        const permitted = SEARCHABLE_DOCUMENT_CATEGORIES.some((c) => can(access, c.permission));
        return {
          omitted: permitted ? (personScope ? "mfa_required" : "no_scope") : "not_permitted",
        };
      }
      const first = allowed[0] as (typeof allowed)[number];
      return {
        entity: {
          type,
          permission: first.permission,
          fields: ["title", "category", "file_name", "person", "created_at"],
          personScoped: allowed.some((c) => c.personScoped),
          careRecord: allowed.some((c) => touchesCareRecords(c.permission)),
          documentCategories: allowed.map((c) => c.category),
        },
      };
    }
    case "note": {
      if (!can(access, "care.note.read")) return { omitted: "not_permitted" };
      if (!personScope) return { omitted: "no_scope" };
      return withMfa({
        type,
        permission: "care.note.read",
        fields: ["person", "excerpt", "occurred_at", "author"],
        personScoped: true,
        careRecord: true,
      });
    }
  }
}

/**
 * Plans an ordinary search: only the kinds of record the user may read, only in their scope, only
 * while their access lasts, and only open records unless they may and do ask for closed ones. An
 * agency worker with no shift recorded has no window at all, so search fails closed.
 */
export function buildSearchPlan(
  request: SearchRequest,
  actor: SearchActor,
  now: Date,
  rates: Pick<PlatformRates, "agencyPostShiftHours">,
): SearchPlanCheck {
  const { access } = actor;
  if (!can(access, "platform.search.use")) return planFail("not_permitted");
  if (actor.window.isAgencyWorker && actor.window.agencyShiftEndsAt === null) {
    return planFail("no_shift_recorded");
  }
  const validUntil = accessValidUntil(actor.window, rates);
  if (validUntil !== null && now.getTime() >= validUntil.getTime()) {
    return planFail("access_expired");
  }
  const includeArchived = request.includeArchived === true;
  if (includeArchived && !can(access, "platform.search.archived")) {
    return planFail("archived_not_permitted");
  }
  const checked = normaliseSearchQuery(request.rawQuery);
  if (!checked.ok) return planFail(checked.problem);
  const query = checked.query;

  const asked = request.entityTypes?.length ? request.entityTypes : SEARCH_ENTITY_TYPES;
  const wanted = SEARCH_ENTITY_TYPES.filter((t) => asked.includes(t));
  const entities: SearchPlanEntity[] = [];
  const omitted: { type: SearchEntityType; reason: SearchOmissionReason }[] = [];
  for (const type of wanted) {
    const decision = decideEntity(type, actor, query);
    if ("entity" in decision) entities.push(decision.entity);
    else omitted.push({ type, reason: decision.omitted });
  }
  if (entities.length === 0) {
    const mfaOnly = omitted.some((o) => o.reason === "mfa_required");
    return planFail(mfaOnly ? "mfa_required" : "nothing_to_search");
  }

  return {
    ok: true,
    plan: {
      kind: "scoped",
      query,
      matching: "prefix",
      entities,
      omitted,
      personScope: entities.some((e) => e.personScoped)
        ? personScopeFor(access, actor.teamIds ?? null)
        : null,
      staffScope: entities.some((e) => e.type === "staff") ? staffScopeFor(access) : null,
      personStatuses: includeArchived ? PERSON_STATUSES : SEARCH_OPEN_PERSON_STATUSES,
      includeArchived,
      validUntil,
      pageSize: SEARCH_LIMITS.pageSize,
      breakGlass: null,
    },
  };
}

function isBreakGlassReasonCode(value: string): value is BreakGlassReasonCode {
  return (BREAK_GLASS_REASON_CODES as readonly string[]).includes(value);
}

export interface BreakGlassSearchRequest {
  readonly rawQuery: string;
  /** The typed reason; stored in the break-glass record, never in the audit event. */
  readonly reason: string;
  readonly reasonCode: BreakGlassReasonCode | string | null;
  readonly includeArchived?: boolean;
}

export interface BreakGlassSearchActor {
  readonly access: EffectiveAccess;
  readonly mfaEnrolled: boolean;
  /** The last sign-in completed with the second step (TOTP or passkey); step-up needs one. */
  readonly lastMfaSignInAt: Date | null;
  /** Break-glass searches this user ran in the 24 hours before now. */
  readonly searchesInLast24Hours: number;
}

/**
 * Plans a break-glass search (master prompt section 4): finding a person outside the user's scope.
 * Needs `platform.search.use` and `people.person.break_glass` with an MFA sign-in within the
 * step-up window, a reason code and a typed reason, a specific query (an NHS number, or at least
 * two name words), and fewer than `break_glass.search_max_per_day` such searches in 24 hours. It
 * matches whole words of names only (no prefixes, no room labels), shows identity fields only for
 * at most `breakGlassMaxResults` people, and withholds location and room until the record is
 * opened through the ordinary break-glass step.
 */
export function buildBreakGlassSearchPlan(
  request: BreakGlassSearchRequest,
  actor: BreakGlassSearchActor,
  now: Date,
  stepUpWindowSeconds: number,
  rates: Pick<PlatformRates, "breakGlassSearchMaxPerDay">,
): SearchPlanCheck {
  const { access } = actor;
  if (!can(access, "platform.search.use")) return planFail("not_permitted");
  const decision = authorise(
    access,
    "people.person.break_glass",
    actor.lastMfaSignInAt,
    now,
    stepUpWindowSeconds,
  );
  if (!decision.allowed) {
    return planFail(decision.reason === "step_up_required" ? "step_up_required" : "not_permitted");
  }
  if (!actor.mfaEnrolled) return planFail("mfa_required");
  if (actor.searchesInLast24Hours >= rates.breakGlassSearchMaxPerDay) {
    return planFail("rate_limited");
  }
  const includeArchived = request.includeArchived === true;
  if (includeArchived && !can(access, "platform.search.archived")) {
    return planFail("archived_not_permitted");
  }
  if (request.reasonCode === null || !isBreakGlassReasonCode(request.reasonCode)) {
    return planFail("reason_code_required");
  }
  const reason = request.reason.trim();
  if (reason.length < SEARCH_LIMITS.breakGlassReasonMinLength) return planFail("reason_too_short");
  if (reason.length > SEARCH_LIMITS.breakGlassReasonMaxLength) return planFail("reason_too_long");
  const checked = normaliseSearchQuery(request.rawQuery);
  if (!checked.ok) return planFail(checked.problem);
  if (checked.query.kind === "text" && checked.query.terms.length < 2) {
    return planFail("query_not_specific");
  }
  return {
    ok: true,
    plan: {
      kind: "break_glass",
      query: checked.query,
      matching: "whole_word",
      entities: [
        {
          type: "person",
          permission: "people.person.break_glass",
          fields: BREAK_GLASS_RESULT_FIELDS,
          personScoped: true,
          careRecord: true,
          matchFields: checked.query.kind === "nhs_number" ? ["nhs_number"] : ["names"],
        },
      ],
      omitted: [],
      personScope: { kind: "tenant" },
      staffScope: null,
      personStatuses: includeArchived ? PERSON_STATUSES : SEARCH_OPEN_PERSON_STATUSES,
      includeArchived,
      validUntil: null,
      pageSize: SEARCH_LIMITS.breakGlassMaxResults,
      breakGlass: { reasonCode: request.reasonCode },
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Results
// ------------------------------------------------------------------------------------------------

/** One candidate row from the database, with what the plan needs to check and rank it. */
export interface SearchHit {
  readonly entityType: SearchEntityType;
  readonly id: string;
  /** Text-search relevance from the database; the last tie-breaker before the id. */
  readonly rank: number;
  /** Whether every term matched a whole word (`exact`) or only as a prefix. */
  readonly matchQuality: "exact" | "prefix";
  /** The person's or colleague's full name, or the document title, for ordering and warnings. */
  readonly sortName: string | null;
  /** People only: their date of birth (YYYY-MM-DD), to order people with the same name. */
  readonly dateOfBirth?: string | null;
  /** The person the record is about (people, their documents and notes); null otherwise. */
  readonly personId: string | null;
  readonly personStatus: PersonStatus | null;
  readonly personLocationId: string | null;
  /** True when the searching user holds an unexpired assignment to the person. */
  readonly assignedToActor: boolean;
  readonly personTeamIds?: readonly string[];
  readonly documentCategory?: string | null;
  /** A note replaced by a correction; the correction is what search shows. */
  readonly superseded?: boolean;
  /** For staff: locations they work at; null means tenant-wide. */
  readonly staffLocationIds?: readonly string[] | null;
}

export interface SearchWarning {
  readonly kind: "same_name";
  /** People in the results who share a name: the screen flags each of them (HZ-001). */
  readonly personIds: readonly string[];
}

export interface SearchResultPage {
  readonly items: readonly SearchHit[];
  /** Per kind, counted only over what the user may see. */
  readonly counts: Readonly<Record<SearchEntityType, number>>;
  readonly total: number;
  readonly hasMore: boolean;
  readonly warnings: readonly SearchWarning[];
  /**
   * Rows the database returned that the plan does not allow. Never shown or counted for the user;
   * anything above zero means row-level security and the plan disagree, so the API raises a
   * security alarm with opaque counts only (HZ-011).
   */
  readonly droppedByPlan: number;
}

function personInScope(scope: SearchPersonScope, hit: SearchHit): boolean {
  if (hit.assignedToActor) return true;
  switch (scope.kind) {
    case "tenant":
      return true;
    case "assigned":
      return false;
    case "locations":
      if (hit.personLocationId === null || !scope.locationIds.includes(hit.personLocationId)) {
        return false;
      }
      return (
        scope.teamIds === null || (hit.personTeamIds ?? []).some((t) => scope.teamIds?.includes(t))
      );
  }
}

function staffInScope(scope: SearchStaffScope | null, hit: SearchHit): boolean {
  if (scope === null) return false;
  if (scope.kind === "tenant") return true;
  const where = hit.staffLocationIds ?? null;
  return where === null || where.some((l) => scope.locationIds.includes(l));
}

function visible(plan: SearchPlan, hit: SearchHit): boolean {
  const entity = plan.entities.find((e) => e.type === hit.entityType);
  if (!entity) return false;
  if (hit.entityType === "staff") return staffInScope(plan.staffScope, hit);
  if (hit.entityType === "document") {
    const category = hit.documentCategory ?? null;
    const rule = SEARCHABLE_DOCUMENT_CATEGORIES.find((c) => c.category === category);
    if (!rule || !(entity.documentCategories ?? []).includes(rule.category)) return false;
    if (!rule.personScoped) return hit.personId === null;
  }
  if (hit.entityType === "note" && hit.superseded === true) return false;
  // Break-glass search matches whole words only: a prefix match is never shown.
  if (plan.matching === "whole_word" && hit.matchQuality !== "exact") return false;
  if (hit.personId === null || hit.personStatus === null || plan.personScope === null) return false;
  if (!plan.personStatuses.includes(hit.personStatus)) return false;
  return personInScope(plan.personScope, hit);
}

const ENTITY_ORDER: Readonly<Record<SearchEntityType, number>> = {
  person: 0,
  staff: 1,
  document: 2,
  note: 3,
};

/** Current people first (those receiving care before those being assessed), then people who left. */
const STATUS_ORDER: readonly PersonStatus[] = [
  "active",
  "on_leave",
  "in_hospital",
  "pre_admission",
  "enquiry",
  "discharged",
  "deceased",
  "not_admitted",
  "archived",
];

const statusRank = (s: PersonStatus | null) => (s === null ? -1 : STATUS_ORDER.indexOf(s));
const nameCollator = new Intl.Collator("en-GB", { sensitivity: "base" });

/**
 * Result order (HZ-001): people before other kinds of record; whole-word matches before prefix
 * matches; then by status (current before former), name, date of birth, relevance and id, so the
 * order is stable and the right person is easiest to find.
 */
export function compareSearchHits(a: SearchHit, b: SearchHit): number {
  return (
    ENTITY_ORDER[a.entityType] - ENTITY_ORDER[b.entityType] ||
    Number(a.matchQuality !== "exact") - Number(b.matchQuality !== "exact") ||
    statusRank(a.personStatus) - statusRank(b.personStatus) ||
    nameCollator.compare(a.sortName ?? "", b.sortName ?? "") ||
    (a.dateOfBirth ?? "").localeCompare(b.dateOfBirth ?? "") ||
    b.rank - a.rank ||
    a.id.localeCompare(b.id)
  );
}

/** People in the results who share a name, compared as the index compares names. */
export function sameNameWarnings(hits: readonly SearchHit[]): SearchWarning[] {
  const groups = new Map<string, string[]>();
  for (const hit of hits) {
    if (hit.entityType !== "person" || hit.personId === null || !hit.sortName) continue;
    const key = searchTerms(hit.sortName).join(" ");
    const ids = groups.get(key) ?? [];
    if (!ids.includes(hit.personId)) ids.push(hit.personId);
    groups.set(key, ids);
  }
  return [...groups.values()]
    .filter((ids) => ids.length > 1)
    .map((personIds) => ({ kind: "same_name" as const, personIds }));
}

/** Applies the plan to the candidate rows, ranks them and counts only what may be seen. */
export function filterSearchResults(
  plan: SearchPlan,
  hits: readonly SearchHit[],
  now: Date,
): SearchResultPage {
  const expired = plan.validUntil !== null && now.getTime() >= plan.validUntil.getTime();
  const shown = expired ? [] : hits.filter((h) => visible(plan, h));
  const counts = Object.fromEntries(SEARCH_ENTITY_TYPES.map((t) => [t, 0])) as Record<
    SearchEntityType,
    number
  >;
  for (const hit of shown) counts[hit.entityType] += 1;
  const ordered = [...shown].sort(compareSearchHits);
  return {
    items: ordered.slice(0, plan.pageSize),
    counts,
    total: shown.length,
    hasMore: shown.length > plan.pageSize,
    warnings: sameNameWarnings(shown),
    droppedByPlan: hits.length - shown.length,
  };
}

// ------------------------------------------------------------------------------------------------
// Alerts and audit
// ------------------------------------------------------------------------------------------------

export interface BreakGlassSearchAlert {
  /** Generic, with no personal data (checked again by `outboundTitleProblem` before sending). */
  readonly title: string;
  readonly body: string;
  /** Registered Managers of these locations, and the data protection lead(s), are told. */
  readonly recipientRoleKeys: readonly ["registered_manager", "data_protection_lead"];
  /** Locations of the people shown, used only to route the alert; never shown to the searcher. */
  readonly locationIds: readonly string[];
  readonly personIds: readonly string[];
}

/**
 * The alert a break-glass search raises as soon as it runs, before any record is opened: the
 * Registered Manager for each location whose people were shown, and the data protection lead. A
 * search refused for the daily limit tells the data protection lead too (`limitReached`).
 */
export function breakGlassSearchAlert(
  page: Pick<SearchResultPage, "items"> | null,
  limitReached = false,
): BreakGlassSearchAlert {
  const items = page?.items ?? [];
  const unique = (values: (string | null)[]) =>
    [...new Set(values.filter((v): v is string => v !== null))].sort();
  return {
    title: limitReached ? "Break-glass search limit reached" : "A break-glass search was made",
    body: "Review the search and its reason in the audit log.",
    recipientRoleKeys: ["registered_manager", "data_protection_lead"],
    locationIds: unique(items.map((h) => h.personLocationId)),
    personIds: unique(items.map((h) => h.personId)),
  };
}

export interface SearchAuditEvent {
  readonly action:
    | "platform.search.run"
    | "platform.search.break_glass"
    | "platform.search.refused";
  readonly outcome: "success" | "denied";
  readonly resourceType: "search";
  /** Always null: a break-glass reason lives in its break-glass record, referenced by id. */
  readonly reason: null;
  readonly scope: {
    readonly queryKind: NormalisedSearchQuery["kind"] | null;
    readonly termCount: number;
    readonly entityTypes: readonly SearchEntityType[];
    readonly omitted: readonly {
      readonly type: SearchEntityType;
      readonly reason: SearchOmissionReason;
    }[];
    readonly includeArchived: boolean;
    readonly personScope: SearchPersonScope["kind"] | null;
    readonly locationIds: readonly string[];
    readonly validUntil: string | null;
    readonly resultCounts: Readonly<Record<SearchEntityType, number>> | null;
    readonly total: number;
    /** The opaque ids shown on the page, by kind. */
    readonly resultIds: Readonly<Record<SearchEntityType, readonly string[]>> | null;
    /** People whose details appeared: each counts as a view of their care record. */
    readonly personIds: readonly string[];
    readonly careRecordView: boolean;
    readonly breakGlassRecordId?: string;
    readonly reasonCode?: BreakGlassReasonCode;
    readonly problem?: SearchPlanProblem;
  };
}

/**
 * The audit event for a search that ran (platform-completions.md rule 8). It holds the opaque ids
 * shown on the page, which count as views of those people's care records, the scope searched and
 * when the user's access ends; never the words typed or the NHS number, not even hashed (a hash of
 * a name can be reversed by trying names). A break-glass search refers to its break-glass record,
 * which holds the typed reason, rather than copying the reason into the audit trail.
 */
export function searchAuditEvent(
  plan: SearchPlan,
  page: SearchResultPage,
  context: { readonly breakGlassRecordId?: string } = {},
): SearchAuditEvent {
  const breakGlass = plan.breakGlass;
  if (breakGlass && !context.breakGlassRecordId) {
    throw new RangeError("A break-glass search is audited with its break-glass record id.");
  }
  const resultIds = Object.fromEntries(
    SEARCH_ENTITY_TYPES.map((t) => [
      t,
      page.items.filter((h) => h.entityType === t).map((h) => h.id),
    ]),
  ) as Record<SearchEntityType, string[]>;
  const personIds = [
    ...new Set(page.items.map((h) => h.personId).filter((id): id is string => id !== null)),
  ].sort();
  const scope = plan.personScope;
  return {
    action: breakGlass ? "platform.search.break_glass" : "platform.search.run",
    outcome: "success",
    resourceType: "search",
    reason: null,
    scope: {
      queryKind: plan.query.kind,
      termCount: plan.query.kind === "text" ? plan.query.terms.length : 1,
      entityTypes: plan.entities.map((e) => e.type),
      omitted: plan.omitted,
      includeArchived: plan.includeArchived,
      personScope: scope?.kind ?? null,
      locationIds: scope?.kind === "locations" ? scope.locationIds : [],
      validUntil: plan.validUntil ? plan.validUntil.toISOString() : null,
      resultCounts: page.counts,
      total: page.total,
      resultIds,
      personIds,
      careRecordView: personIds.length > 0,
      ...(breakGlass
        ? { breakGlassRecordId: context.breakGlassRecordId, reasonCode: breakGlass.reasonCode }
        : {}),
    },
  };
}

/** The audit event for a search refused before it ran; again without the words typed. */
export function searchRefusalAuditEvent(
  problem: SearchPlanProblem,
  entityTypes: readonly SearchEntityType[] = SEARCH_ENTITY_TYPES,
): SearchAuditEvent {
  return {
    action: "platform.search.refused",
    outcome: "denied",
    resourceType: "search",
    reason: null,
    scope: {
      queryKind: null,
      termCount: 0,
      entityTypes,
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
      problem,
    },
  };
}
