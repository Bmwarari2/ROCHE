import { z } from "zod";
import { BreakGlassReasonCode, PersonStatus } from "./people";

/**
 * Permission-aware search (PLAT-013; platform-completions.md rules 1 to 8; ADR-0070; HZ-001,
 * HZ-011). The words typed travel in the request body, never the address, so they reach no access
 * log; results show only the fields the plan allows for each kind.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const SearchEntityType = z
  .enum(["person", "staff", "document", "note"])
  .meta({ id: "SearchEntityType" });
export type SearchEntityType = z.infer<typeof SearchEntityType>;

export const RunSearch = z
  .object({
    /** Up to 200 characters; longer is refused before any other work (rule 2). */
    query: z.string().max(200),
    /** Kinds of record asked for; every kind the user may search when left out. */
    types: z.array(SearchEntityType).max(4).optional(),
    /** People who have left (`platform.search.archived` only). */
    includeArchived: z.boolean().optional(),
  })
  .meta({ id: "RunSearch" });

export const SearchPersonResult = z
  .object({
    id: uuid,
    name: z.string(),
    preferredName: z.string().nullable(),
    /** YYYY-MM-DD; null for names-and-rooms roles, which see the age instead. */
    dateOfBirth: z.string().nullable(),
    age: z.number().int().nullable(),
    nhsNumber: z.string().nullable(),
    status: PersonStatus,
    locationName: z.string().nullable(),
    roomLabel: z.string().nullable(),
    hasPhoto: z.boolean(),
    /** Accessible Information Standard needs, by their display words (shown before opening). */
    communicationNeeds: z.array(z.string()),
    /** HZ-072: an invented sample person, shown with the "Sample" badge. */
    sample: z.boolean(),
  })
  .meta({ id: "SearchPersonResult" });

export const SearchResultItem = z
  .object({
    type: SearchEntityType,
    id: uuid,
    /** Every word matched whole (`exact`), or only as the start of a word (`prefix`). */
    match: z.enum(["exact", "prefix"]),
    /** Another person in these results has the same name (HZ-001). */
    sameName: z.boolean(),
    person: SearchPersonResult.nullable(),
    staff: z
      .object({ name: z.string(), roles: z.array(z.string()), locations: z.array(z.string()) })
      .nullable(),
    document: z
      .object({
        title: z.string(),
        category: z.string(),
        fileName: z.string().nullable(),
        createdAt: isoDateTime,
        personId: uuid.nullable(),
        personName: z.string().nullable(),
      })
      .nullable(),
    note: z
      .object({
        personId: uuid,
        personName: z.string(),
        excerpt: z.string(),
        occurredAt: isoDateTime,
        author: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: "SearchResultItem" });

export const SearchOmission = z
  .object({
    type: SearchEntityType,
    reason: z.enum(["not_permitted", "no_scope", "mfa_required", "not_applicable"]),
  })
  .meta({ id: "SearchOmission" });

export const SearchResults = z
  .object({
    items: z.array(SearchResultItem),
    /** Per kind, counted only over what the user may see. */
    counts: z.record(z.string(), z.number().int()),
    total: z.number().int(),
    hasMore: z.boolean(),
    /** Some kind matched more rows than are read (`readLimit`): ask for another word. */
    capped: z.boolean(),
    readLimit: z.number().int(),
    /** Kinds asked for and not searched, with why (never anything about a record). */
    omitted: z.array(SearchOmission),
    /** Whom people, documents and notes were searched among, for the screen to say. */
    personScope: z.enum(["tenant", "locations", "assigned"]).nullable(),
    staffScope: z.enum(["tenant", "locations"]).nullable(),
    includeArchived: z.boolean(),
    queryKind: z.enum(["text", "nhs_number"]),
    /** Words too short or beyond the six kept, so the screen can say they were ignored. */
    ignoredTerms: z.number().int(),
  })
  .meta({ id: "SearchResults" });
export type SearchResults = z.infer<typeof SearchResults>;
export type SearchResultItem = z.infer<typeof SearchResultItem>;

/**
 * A break-glass search (platform-completions.md rule 9): a person outside the user's scope, by NHS
 * number or full name (whole words only), with a reason code and a typed reason kept in the
 * break-glass record, never in the audit event.
 */
export const RunBreakGlassSearch = z
  .object({
    query: z.string().max(200),
    reasonCode: BreakGlassReasonCode,
    reason: z.string().max(1000),
    includeArchived: z.boolean().optional(),
  })
  .meta({ id: "RunBreakGlassSearch" });

export const BreakGlassSearchResults = z
  .object({
    /** Identity only, read-only: location and room appear once the record is opened. */
    items: z.array(
      z.object({
        id: uuid,
        name: z.string(),
        preferredName: z.string().nullable(),
        dateOfBirth: z.string().nullable(),
        nhsNumber: z.string().nullable(),
        status: PersonStatus,
        sameName: z.boolean(),
      }),
    ),
    /** The people shown, at most the page size; `more` says others match too. */
    total: z.number().int(),
    /** More people match than are shown: the searcher should add a word or use the NHS number. */
    more: z.boolean(),
    /** The break-glass record holding the reason; opening a result is a separate break-glass step. */
    breakGlassId: uuid,
  })
  .meta({ id: "BreakGlassSearchResults" });
export type BreakGlassSearchResults = z.infer<typeof BreakGlassSearchResults>;
