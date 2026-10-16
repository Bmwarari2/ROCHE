import type { SearchResultItem, SearchResults } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { initialsOf, resultHref, scopeStatement, searchShown, typesFor } from "./search";

const item = (change: Partial<SearchResultItem>): SearchResultItem => ({
  type: "person",
  id: "p1",
  match: "exact",
  sameName: false,
  person: null,
  staff: null,
  document: null,
  note: null,
  ...change,
});

describe("search on the web (PLAT-013, HZ-011)", () => {
  it("shows the search link only with platform.search.use", () => {
    expect(searchShown(["platform.search.use"])).toBe(true);
    expect(searchShown(["people.person.read"])).toBe(false);
  });

  it.each([
    ["all", undefined],
    ["person", ["person"]],
    ["note", ["note"]],
  ] as const)("asks the API for %s", (kind, types) => {
    expect(typesFor(kind)).toEqual(types);
  });

  it("opens each result on the screen that shows it", () => {
    expect(resultHref(item({ type: "person", id: "p1" }))).toBe("/people/p1");
    expect(resultHref(item({ type: "document", id: "d1" }))).toBe("/documents/d1");
    expect(
      resultHref(
        item({
          type: "note",
          id: "n1",
          note: {
            personId: "p2",
            personName: "Ada Example",
            excerpt: "",
            occurredAt: "",
            author: null,
          },
        }),
      ),
    ).toBe("/people/p2/notes");
    expect(resultHref(item({ type: "staff", id: "u1" }))).toBeNull();
  });

  it("says where it looked and what it left out, never a kind that did not apply", () => {
    const results: SearchResults = {
      items: [],
      counts: {},
      total: 0,
      hasMore: false,
      capped: false,
      readLimit: 100,
      omitted: [
        { type: "note", reason: "mfa_required" },
        { type: "staff", reason: "not_applicable" },
      ],
      personScope: "assigned",
      staffScope: null,
      includeArchived: false,
      queryKind: "text",
      ignoredTerms: 0,
    };
    expect(scopeStatement(results)).toEqual({
      person: "assigned",
      staff: null,
      includeArchived: false,
      omitted: [{ type: "note", reason: "mfa_required" }],
    });
  });

  it("makes two-letter initials", () => {
    expect(initialsOf("Ada Example")).toBe("AE");
    expect(initialsOf("Ada")).toBe("A");
  });
});
