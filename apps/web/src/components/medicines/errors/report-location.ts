import "server-only";
import { notFound } from "next/navigation";
import { getShellContext, problemCode } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { reviewsShown } from "@/lib/medication-errors";
import { problemMessage } from "@/lib/outcome";

/**
 * The location a medicines report is for (slice 55; medicines.md section 14.4): one in the
 * reader's list, for a holder of `medicines.record.manage`. Null means the page says the reader
 * may not see it; the API checks again that their scope covers the whole location.
 */
export async function reportLocation(
  locationId: string,
): Promise<{ readonly id: string; readonly name: string } | null> {
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  if (!reviewsShown(me.permissions)) return null;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  return { id: location.id, name: location.name };
}

/** How a report read went: refused for this reader, refused in words (the period), or failed. */
export function reportProblem(
  error: unknown,
): { readonly kind: "forbidden" } | { readonly kind: "refused"; readonly message: string } | null {
  const code = problemCode(error);
  if (code === "missing_permission") return { kind: "forbidden" };
  if (code === "invalid") return { kind: "refused", message: problemMessage(error, t).message };
  return null;
}
