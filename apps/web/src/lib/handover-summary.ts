import type { HandoverItem } from "@harbour/contracts";
import { HANDOVER_SUMMARY_KEYS } from "@harbour/domain";
import type { MessageKey, Translator } from "@harbour/i18n";

/**
 * The words of a handover item on the web, from the summary the server compiled with it (a
 * catalogue key and its parameters; the API returns it with each item to readers of the handover,
 * whose permissions reach its sources, ADR-0071), as the phone words it (`HANDOVER_SUMMARY_KEYS`,
 * H-427), so the reader learns what is handed over without opening every record (H-269, HZ-018).
 * Each key is worded from the `care.` catalogue; an item without a summary (compiled before
 * summaries existed), or with a key this build does not know, is worded by its kind alone, never
 * left blank and never shown as a raw key. Pure and unit tested.
 */

const KNOWN: ReadonlySet<string> = new Set(Object.values(HANDOVER_SUMMARY_KEYS));

const text = (v: string | number | undefined) => (typeof v === "string" ? v : "");

/** What the item says, in the reader's words. */
export function handoverItemWords(
  item: Pick<HandoverItem, "kind" | "summary">,
  t: Translator,
): string {
  const fallback = () => t("care.handover.summary.none", { kind: item.kind ?? "other" });
  const summary = item.summary;
  if (!summary || !KNOWN.has(summary.key)) return fallback();
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(summary.params ?? {})) {
    if (typeof value === "string" || typeof value === "number") params[name] = value;
  }
  if (summary.key === HANDOVER_SUMMARY_KEYS.body_map_mark) {
    // The mark's type, area and side as the web's body map words them.
    params.mark = t("care.handover.summary.markWords", {
      type: t("care.bodyMap.markTypeOption", { type: text(params.markType) || "other" }),
      region: t("care.bodyMap.regionName", { region: text(params.region) || "other" }),
      side: t("care.handover.summary.markSide", { side: text(params.side) || "other" }),
    });
  }
  if (summary.key === HANDOVER_SUMMARY_KEYS.skipped_task) {
    params.hasReason = text(params.reason).trim() ? "yes" : "no";
  }
  // A task's plan action and earlier-plan flag, and an alert's reason, default when a summary was
  // compiled before they were kept, so it is still worded.
  params.planned = text(params.planAction).trim() ? "yes" : "no";
  params.planAction ??= "";
  params.earlierPlan ??= "no";
  params.reason ??= "other";
  // An alert compiled before it carried its NEWS2 score is worded without one.
  params.scored ??= "no";
  params.band ??= "other";
  try {
    return t(`care.${summary.key}` as MessageKey, params);
  } catch {
    return fallback();
  }
}
