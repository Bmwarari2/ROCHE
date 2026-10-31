import type { DependencyScaleDefinition } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { readClockTime } from "./rota";

/**
 * The dependency scale screens (scheduling.md section 12; CARE-004, SCHED-001; HZ-123). Pure and
 * unit tested. The scale is the organisation's own tool: every figure is theirs, the pages say so,
 * and nothing here is a score. The API checks the definition again and lists its problems.
 */

export const DEPENDENCY_PAGE = "/settings/dependency";
export const dependencyScalePage = (id: string) => `${DEPENDENCY_PAGE}/${id}`;
export const personDependencyPage = (personId: string) => `/people/${personId}/dependency`;

export const DEPENDENCY_READERS = [
  "scheduling.dependency.manage",
  "care.dependency.assess",
  "scheduling.rota.manage",
  "scheduling.rota.read",
] as const;

export function dependencyShown(permissions: readonly string[]): boolean {
  return DEPENDENCY_READERS.some((p) => permissions.includes(p));
}
export function mayManageScales(permissions: readonly string[]): boolean {
  return permissions.includes("scheduling.dependency.manage");
}
export function mayAssess(permissions: readonly string[]): boolean {
  return permissions.includes("care.dependency.assess");
}
export function personDependencyShown(permissions: readonly string[]): boolean {
  return mayAssess(permissions) || permissions.includes("care.plan.read");
}

export const SKILLS = [
  "registered_nurse",
  "medicines_competent",
  "moving_and_handling",
  "driver",
] as const;

/** A stable key from a label: lower case letters, digits and underscores, at most 40. */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 36) || "item";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

/** The editor's rows, as text the person typed. */
export interface DraftPeriod {
  readonly key: string;
  readonly label: string;
  readonly start: string;
}
export interface DraftCategory {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Care minutes per person, by period key, as typed. */
  readonly minutes: Readonly<Record<string, string>>;
}
export interface DraftSkill {
  readonly skill: string;
  readonly periodKey: string;
  readonly minimumStaff: string;
}
export interface DraftDefinition {
  readonly periods: readonly DraftPeriod[];
  readonly categories: readonly DraftCategory[];
  readonly skillMix: readonly DraftSkill[];
  readonly reviewIntervalDays: string;
}

const pad = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** The editor's rows from a stored definition. */
export function toDraft(definition: DependencyScaleDefinition): DraftDefinition {
  return {
    periods: definition.periods.map((p) => ({
      key: p.key,
      label: p.label,
      start: pad(p.startMinute),
    })),
    categories: definition.categories.map((c) => ({
      key: c.key,
      label: c.label,
      description: c.description ?? "",
      minutes: Object.fromEntries(c.careMinutes.map((m) => [m.periodKey, String(m.minutes)])),
    })),
    skillMix: definition.skillMix.map((s) => ({
      skill: s.skill,
      periodKey: s.periodKey,
      minimumStaff: String(s.minimumStaff),
    })),
    reviewIntervalDays:
      definition.reviewIntervalDays === null ? "" : String(definition.reviewIntervalDays),
  };
}

export const EMPTY_DRAFT: DraftDefinition = {
  periods: [
    { key: "day", label: "Day", start: "08:00" },
    { key: "night", label: "Night", start: "20:00" },
  ],
  categories: [],
  skillMix: [],
  reviewIntervalDays: "",
};

export type ReadDefinition =
  | { readonly ok: true; readonly definition: DependencyScaleDefinition }
  | { readonly ok: false; readonly problems: readonly string[] };

const wholeNumber = (text: string, max: number): number | null => {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n <= max ? n : null;
};

/**
 * The definition the API takes from the editor's rows, or the problems in words. The API checks
 * it again (and lists what an approval needs); this only refuses what it could not send.
 */
export function readDefinition(draft: DraftDefinition, t: Translator): ReadDefinition {
  const problems: string[] = [];
  const periods = draft.periods.map((p, i) => {
    const start = readClockTime(p.start);
    if (!p.label.trim()) problems.push(t("dependency.edit.periodLabel", { n: i + 1 }));
    if (start === null) problems.push(t("dependency.edit.periodStart", { n: i + 1 }));
    return { key: p.key, label: p.label.trim(), startMinute: start ?? 0 };
  });
  const periodKeys = new Set(periods.map((p) => p.key));
  const categories = draft.categories.map((c, i) => {
    if (!c.label.trim()) problems.push(t("dependency.edit.categoryLabel", { n: i + 1 }));
    const careMinutes = periods.flatMap((p) => {
      const raw = (c.minutes[p.key] ?? "").trim();
      if (raw === "") return [];
      const minutes = wholeNumber(raw, 2880);
      if (minutes === null) {
        problems.push(
          t("dependency.edit.minutes", { category: c.label || String(i + 1), period: p.label }),
        );
        return [];
      }
      return [{ periodKey: p.key, minutes }];
    });
    return {
      key: c.key,
      label: c.label.trim(),
      description: c.description.trim() ? c.description.trim() : null,
      careMinutes,
    };
  });
  const skillMix = draft.skillMix.flatMap((s, i) => {
    const minimumStaff = wholeNumber(s.minimumStaff, 100);
    if (
      minimumStaff === null ||
      !periodKeys.has(s.periodKey) ||
      !(SKILLS as readonly string[]).includes(s.skill)
    ) {
      problems.push(t("dependency.edit.skill", { n: i + 1 }));
      return [];
    }
    return [{ skill: s.skill as (typeof SKILLS)[number], periodKey: s.periodKey, minimumStaff }];
  });
  let reviewIntervalDays: number | null = null;
  if (draft.reviewIntervalDays.trim() !== "") {
    reviewIntervalDays = wholeNumber(draft.reviewIntervalDays, 3650);
    if (reviewIntervalDays === null) problems.push(t("dependency.edit.review"));
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, definition: { periods, categories, skillMix, reviewIntervalDays } };
}

/** "Day from 08:00, Night from 20:00", for a version's summary (empty for one whole-day period). */
export function periodsWords(
  definition: Pick<DependencyScaleDefinition, "periods">,
  t: Translator,
): string {
  return definition.periods
    .map((p) => t("dependency.view.period", { label: p.label, start: pad(p.startMinute) }))
    .join(", ");
}

/** A version's state as an icon and a word. */
export function versionChip(state: string, t: Translator) {
  const known: Record<
    string,
    { status: "done" | "due" | "notApplicable"; icon: "circle-check" | "file-pen" | "circle-minus" }
  > = {
    approved: { status: "done", icon: "circle-check" },
    draft: { status: "due", icon: "file-pen" },
    superseded: { status: "notApplicable", icon: "circle-minus" },
    discarded: { status: "notApplicable", icon: "circle-minus" },
  };
  const chip = known[state];
  return chip
    ? { ...chip, label: t("dependency.state", { state }) }
    : {
        status: "overdue" as const,
        icon: "circle-alert" as const,
        label: t("dependency.state", { state: "unknown" }),
      };
}
