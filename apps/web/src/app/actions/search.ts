"use server";

import type { SearchResults } from "@harbour/contracts";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { SEARCH_KINDS, SEARCH_MAX_LENGTH, type SearchKind, typesFor } from "@/lib/search";

/**
 * Runs a search as the signed-in person (PLAT-013). The words go to the API in the request body,
 * never in an address, so no log or browser history holds them; the API plans, filters, ranks and
 * audits the search.
 */
export async function runSearch(input: {
  readonly query: string;
  readonly kind: SearchKind;
  readonly includeArchived: boolean;
}): Promise<ActionResult<SearchResults>> {
  if (!SEARCH_KINDS.includes(input.kind)) return refused(t("care.errors.invalid"));
  if (input.query.length > SEARCH_MAX_LENGTH) {
    return refused(t("platform.search.tooLong", { max: SEARCH_MAX_LENGTH }), "invalid", ["query"]);
  }
  try {
    const api = await tenantApi();
    const types = typesFor(input.kind);
    const { data, error } = await api.POST("/v1/search", {
      body: {
        query: input.query,
        ...(types ? { types } : {}),
        ...(input.includeArchived ? { includeArchived: true } : {}),
      },
    });
    if (data) return { ok: true, data };
    const problem = problemMessage(error, t);
    // The API's own words for a query it cannot search (an NHS number that fails its check).
    return problem.code === "invalid"
      ? { ok: false, ...problem, fields: { query: problem.message } }
      : (searchRefusal(error) ?? { ok: false, ...problem });
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Refusals search has its own words for (platform-completions.md rules 4 to 6). */
function searchRefusal(error: unknown): ActionResult<never> | null {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  switch (code) {
    case "no_shift_recorded":
    case "access_expired":
    case "archived_not_permitted":
    case "nothing_to_search":
    case "not_permitted":
      return refused(t("platform.search.refusal", { code }), code);
    default:
      return null;
  }
}
