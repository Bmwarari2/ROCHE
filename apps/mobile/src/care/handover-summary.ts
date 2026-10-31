/**
 * The words of a handover item on the phone, from the summary the server compiled with it
 * (`handover_item.summary`: a catalogue key and its parameters; care.md section 6, screens gate
 * item (a); H-300), so the handover screen needs none of the sources the phone does not hold
 * (incidents, alerts, skipped tasks). Each key is worded from the `mobile.` catalogue in the
 * reader's language; an item without a summary (compiled before summaries existed), with one the
 * phone cannot read, or with a key this build does not know is worded by its kind alone, never
 * left blank and never shown as a raw key.
 */
import { HANDOVER_SUMMARY_KEYS } from "@harbour/domain";
import { type MessageKey, t } from "../i18n/t";
import { markSummary } from "./entry-view";

const KNOWN: ReadonlySet<string> = new Set(Object.values(HANDOVER_SUMMARY_KEYS));

/** A synced handover item, as the screen reads it. */
export interface HandoverItemRow {
  readonly kind: string | null;
  /** JSON text, as synced. */
  readonly summary: string | null;
}

interface Summary {
  readonly key: string;
  readonly params: Record<string, string | number>;
}

function parseSummary(value: string | null): Summary | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { key, params } = parsed as { key?: unknown; params?: unknown };
  if (typeof key !== "string" || !KNOWN.has(key)) return null;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const clean: Record<string, string | number> = {};
  for (const [name, v] of Object.entries(params)) {
    if (typeof v === "string" || typeof v === "number") clean[name] = v;
  }
  return { key, params: clean };
}

const text = (v: string | number | undefined) => (typeof v === "string" ? v : "");

/** What the item says, in the reader's words. */
export function handoverItemWords(item: HandoverItemRow): string {
  const fallback = () => t("mobile.handover.summary.none", { kind: item.kind ?? "other" });
  const summary = parseSummary(item.summary);
  if (!summary) return fallback();
  const params: Record<string, string | number> = { ...summary.params };
  if (summary.key === HANDOVER_SUMMARY_KEYS.body_map_mark) {
    // The mark's type, area and side as the body map words them on this phone.
    params.mark = markSummary({
      mark_type: text(params.markType) || null,
      view: text(params.view) || null,
      region: text(params.region) || null,
      side: text(params.side) || null,
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
  try {
    return t(`mobile.${summary.key}` as MessageKey, params);
  } catch {
    return fallback();
  }
}
