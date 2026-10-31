import type { SearchResultItem, SearchResults } from "@harbour/contracts";

/**
 * Search on the web (platform-completions.md rules 1 to 8; PLAT-013; HZ-001, HZ-011). The API
 * plans, filters and ranks every search; these helpers only say what it searched and link each
 * result to the screen that shows it.
 */

export const SEARCH_USE = "platform.search.use";
export const SEARCH_ARCHIVED = "platform.search.archived";
export const BREAK_GLASS = "people.person.break_glass";

/** Break-glass search (rule 9): the reason codes and the typed reason's bounds the API checks. */
export const BREAK_GLASS_REASON_CODES = [
  "emergency_care",
  "covering_another_area",
  "safeguarding",
  "incident_or_complaint",
  "request_from_professional",
  "other",
] as const;
export type BreakGlassReasonCode = (typeof BREAK_GLASS_REASON_CODES)[number];
export const BREAK_GLASS_REASON_MIN = 20;
export const BREAK_GLASS_REASON_MAX = 1000;

/** The break-glass search is offered with search and the break-glass permission. */
export function breakGlassSearchShown(permissions: readonly string[]): boolean {
  return permissions.includes(SEARCH_USE) && permissions.includes(BREAK_GLASS);
}
export const SEARCH_MAX_LENGTH = 200;
export const SEARCH_KINDS = ["all", "person", "staff", "document", "note"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export function searchShown(permissions: readonly string[]): boolean {
  return permissions.includes(SEARCH_USE);
}

/** The kinds the API is asked for: every kind it allows, or one. */
export function typesFor(kind: SearchKind): SearchResultItem["type"][] | undefined {
  return kind === "all" ? undefined : [kind];
}

/** Where a result opens: the person's record, the document, or the person's notes. */
export function resultHref(item: SearchResultItem): string | null {
  switch (item.type) {
    case "person":
      return `/people/${item.id}`;
    case "document":
      return `/documents/${item.id}`;
    case "note":
      return item.note ? `/people/${item.note.personId}/notes` : null;
    case "staff":
      return null;
  }
}

/** Two letters for a person's avatar when there is no photo. */
export function initialsOf(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}

/**
 * What the results say about where the search looked (HZ-011): the scope people, documents and
 * notes were searched in, colleagues' scope, whether people who have left were included, and each
 * kind left out with why. An empty result is then never read as "this person is not here".
 */
export function scopeStatement(results: SearchResults): {
  readonly person: SearchResults["personScope"];
  readonly staff: SearchResults["staffScope"];
  readonly includeArchived: boolean;
  readonly omitted: SearchResults["omitted"];
} {
  return {
    person: results.personScope,
    staff: results.staffScope,
    includeArchived: results.includeArchived,
    omitted: results.omitted.filter((o) => o.reason !== "not_applicable"),
  };
}
