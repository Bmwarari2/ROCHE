/**
 * What lists show for each entry: the latest in each correction chain, when it happened (UK time),
 * a short summary, and its state in words with an icon: waiting to upload, saved, late entry,
 * device clock wrong (HZ-002, HZ-006, HZ-010, HZ-017). Entries the server refused are listed apart
 * as "not saved: needs attention" with their content, so nothing is lost silently.
 */
import {
  type BodyView,
  BRISTOL_STOOL_SCALE,
  describeIddsiLevel,
  findBodyRegion,
} from "@harbour/domain";
import { fullName, knownAsName } from "@harbour/ui-native/logic";
import { t } from "../i18n/t";
import { type ChartKind, isChartKind, readNews2, type StoredNews2 } from "./charts";
import { currentEntries, type EntryStatus, entryStatus, flag } from "./entries";
import type { MarkRow, NoteRow, ObservationRow, UploadIssueRow } from "./queries";
import { parseInstant, ukDateTimeParts } from "./time";

export type EntryTable = "care_note" | "observation" | "body_map_mark";

export interface EntryItem {
  readonly id: string;
  readonly table: EntryTable;
  readonly chart: ChartKind | null;
  readonly occurredAt: Date | null;
  /** "11/10/2026 at 14:05". */
  readonly when: string;
  readonly title: string;
  readonly summary: string;
  readonly status: EntryStatus;
  readonly late: boolean;
  readonly clockDrift: boolean;
  /** "Corrects an earlier entry. Reason: ..." when this entry is a correction. */
  readonly correction: string | null;
  readonly news2: StoredNews2 | null;
}

function when(occurredAt: Date | null): string {
  if (!occurredAt) return "";
  const { date, time } = ukDateTimeParts(occurredAt);
  return t("mobile.common.dateTime", { date, time });
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function iddsi(kind: "food" | "drink", code: unknown): string | null {
  if (typeof code !== "string") return null;
  try {
    return describeIddsiLevel(kind, code);
  } catch {
    return code;
  }
}

/** A one-line summary of chart values, in words. */
export function observationSummary(
  chart: string | null,
  valuesJson: string | null,
  flagsJson: string | null,
): string {
  const v = parseObject(valuesJson);
  const parts: Array<string | null> = [];
  switch (chart) {
    case "fluid_intake":
      parts.push(
        t("mobile.summary.ml", { ml: Number(v.ml ?? 0) }),
        typeof v.drink === "string" ? v.drink : null,
        iddsi("drink", v.iddsiLevel),
        v.refused === true ? t("mobile.summary.refused") : null,
      );
      break;
    case "fluid_output":
      parts.push(
        t("mobile.summary.ml", { ml: Number(v.ml ?? 0) }),
        t("mobile.chart.outputKindName", { kind: String(v.kind ?? "other") }),
      );
      break;
    case "food":
      parts.push(
        `${t("mobile.chart.mealName", { meal: String(v.meal ?? "other") })}: ${t(
          "mobile.chart.portionName",
          { portion: String(v.portion ?? "other") },
        )}`,
        iddsi("food", v.iddsiLevel),
        v.refused === true ? t("mobile.summary.refused") : null,
      );
      break;
    case "repositioning":
      parts.push(
        t("mobile.chart.positionName", { position: String(v.position ?? "other") }),
        t(v.skinChecked === true ? "mobile.summary.skinChecked" : "mobile.summary.skinNotChecked"),
        v.declined === true ? t("mobile.summary.declined") : null,
      );
      break;
    case "bowel": {
      const type = Number(v.bristolType);
      parts.push(
        v.noMovement === true || !(type in BRISTOL_STOOL_SCALE)
          ? t("mobile.chart.noMovement")
          : t("mobile.chart.bristolType", {
              type,
              description: BRISTOL_STOOL_SCALE[type as keyof typeof BRISTOL_STOOL_SCALE],
            }),
      );
      break;
    }
    case "weight":
      parts.push(
        t("mobile.summary.kg", { kg: Number(v.kg ?? 0) }),
        t("mobile.chart.methodName", { method: String(v.method ?? "other") }),
      );
      break;
    case "vitals": {
      const news2 = readNews2(flagsJson);
      parts.push(
        news2
          ? t("mobile.summary.news2", { score: news2.score, risk: news2.clinicalRisk })
          : t("mobile.news2.incomplete"),
      );
      break;
    }
  }
  return parts.filter((p): p is string => Boolean(p)).join(", ");
}

function base(
  row: NoteRow | ObservationRow | MarkRow,
  table: EntryTable,
  demo: boolean,
): Omit<EntryItem, "title" | "summary" | "chart" | "news2"> {
  const occurredAt = parseInstant(row.occurred_at);
  return {
    id: row.id,
    table,
    occurredAt,
    when: when(occurredAt),
    status: entryStatus(row, demo),
    late: flag(row.late_entry),
    clockDrift: flag(row.clock_drift),
    correction: row.supersedes_id
      ? t("mobile.entry.correction", { reason: row.correction_reason ?? "" })
      : null,
  };
}

export function noteItem(row: NoteRow, demo: boolean): EntryItem {
  return {
    ...base(row, "care_note", demo),
    chart: null,
    news2: null,
    title: t("mobile.note.categoryName", { category: row.category ?? "other" }),
    summary: row.body ?? "",
  };
}

export function observationItem(row: ObservationRow, demo: boolean): EntryItem {
  const chart = row.chart && isChartKind(row.chart) ? row.chart : null;
  return {
    ...base(row, "observation", demo),
    chart,
    news2: chart === "vitals" ? readNews2(row.flags) : null,
    title: t("mobile.chart.name", { chart: chart ?? "other" }),
    summary: observationSummary(row.chart, row.chart_values, row.flags),
  };
}

/** "Bruise on Shin, the person's left". */
export function markSummary(row: Pick<MarkRow, "view" | "region" | "side" | "mark_type">): string {
  const region =
    row.view && row.region ? findBodyRegion(row.view as BodyView, row.region)?.label : undefined;
  return t("mobile.entry.markSummary", {
    type: t("mobile.bodyMap.markTypeName", { type: row.mark_type ?? "other" }),
    region: region ?? row.region ?? "",
    side: t("mobile.bodyMap.sideWords", { side: row.side ?? "other" }),
  });
}

export function markItem(row: MarkRow, demo: boolean): EntryItem {
  return {
    ...base(row, "body_map_mark", demo),
    chart: null,
    news2: null,
    title: t("mobile.entry.kind", { table: "body_map_mark" }),
    summary: markSummary(row),
  };
}

/** Notes, chart entries and marks together, latest in each chain, newest first. */
export function recentEntries(
  notes: readonly NoteRow[],
  observations: readonly ObservationRow[],
  marks: readonly MarkRow[],
  demo: boolean,
): EntryItem[] {
  return [
    ...currentEntries(notes).map((r) => noteItem(r, demo)),
    ...currentEntries(observations).map((r) => observationItem(r, demo)),
    ...currentEntries(marks).map((r) => markItem(r, demo)),
  ].sort((a, b) => (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0));
}

export interface IssueItem {
  readonly id: string;
  readonly personId: string | null;
  readonly title: string;
  readonly reason: string;
  readonly content: string | null;
  readonly when: string;
  /** Whether Harbour has a copy, in words, when it is known (Device integrity part 5). */
  readonly copy: string | null;
}

/** A refused upload, with enough of its content for someone to record it again. */
export function issueItem(row: UploadIssueRow): IssueItem {
  const payload = parseObject(row.payload);
  const name = {
    preferredName: row.preferred_name,
    givenName: row.given_name,
    familyName: row.family_name,
  };
  const known = knownAsName(name);
  const family = (row.family_name ?? "").trim();
  const display =
    known && family && known !== family ? `${known} ${family}` : known || fullName(name);
  let content: string | null = null;
  if (row.record_table === "care_note" && typeof payload.body === "string") content = payload.body;
  else if (row.record_table === "observation") {
    content = observationSummary(
      typeof payload.chart === "string" ? payload.chart : null,
      typeof payload.chart_values === "string" ? payload.chart_values : null,
      typeof payload.flags === "string" ? payload.flags : null,
    );
  } else if (row.record_table === "body_map_mark") {
    content = markSummary({
      view: typeof payload.view === "string" ? payload.view : null,
      region: typeof payload.region === "string" ? payload.region : null,
      side: typeof payload.side === "string" ? payload.side : null,
      mark_type: typeof payload.mark_type === "string" ? payload.mark_type : null,
    });
  }
  const occurred = parseInstant(
    typeof payload.occurred_at === "string" ? payload.occurred_at : null,
  );
  return {
    id: row.id,
    personId: row.person_id,
    title: t("mobile.issues.item", {
      table: row.record_table ?? "other",
      name: display || t("mobile.common.notRecorded"),
    }),
    reason: t("mobile.issues.reason", { reason: row.message ?? t("mobile.issues.unknownReason") }),
    // What was recorded stays until someone removes the entry (clinical review M1).
    content: content ? t("mobile.issues.content", { content }) : null,
    when: when(occurred),
    copy:
      row.server_copy === "copied"
        ? t("mobile.issues.copySent")
        : row.server_copy === "refused"
          ? t("mobile.issues.copyRefused")
          : null,
  };
}
