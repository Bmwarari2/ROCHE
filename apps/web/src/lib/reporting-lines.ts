import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "@/lib/incidents";
import { STAFF_FILE_MANAGE, STAFF_FILE_READ } from "@/lib/workforce";

/**
 * Reporting lines on the web (ADR-0137, PR 2): a member's line manager and staff teams. Only HR
 * (organisation-wide `workforce.staff_file.manage`) maintains them; the development readers see
 * them. The API and row-level security decide again; these only choose what is offered. Every
 * state is an icon and a word, never colour alone.
 */

/** Who may read teams (as the API's staff readers). */
export const TEAM_READERS = [
  STAFF_FILE_MANAGE,
  STAFF_FILE_READ,
  "workforce.training.manage",
  "workforce.competence.observe",
  "workforce.supervision.manage",
] as const;

export const teamsShown = (permissions: readonly string[]) =>
  TEAM_READERS.some((p) => permissions.includes(p));

/**
 * Whether the forms are offered: HR holds the staff file permission organisation-wide. A manager
 * at one home with the same permission sees the screens read only (the API refuses them with
 * 403 reporting_lines_organisation_wide).
 */
export const maintainsReportingLines = (me: {
  readonly permissions: readonly string[];
  readonly scope: string;
}) => me.permissions.includes(STAFF_FILE_MANAGE) && me.scope === "tenant";

export const lineManagerHref = (fileId: string) => `/workforce/staff/${fileId}/line-manager`;
export const teamsHref = "/workforce/teams";
export const teamHref = (teamId: string) => `/workforce/teams/${teamId}`;

/** A line or a membership: current while it has no end date, ended once it has. */
export function periodChip(validTo: string | null, t: Translator): SafetyChip {
  return validTo === null
    ? { status: "done", icon: "circle-check", label: t("workforce.reporting.current") }
    : { status: "neutral", icon: "circle-minus", label: t("workforce.reporting.ended") };
}

export function teamChip(archived: boolean, t: Translator): SafetyChip {
  return archived
    ? { status: "neutral", icon: "circle-minus", label: t("workforce.teams.archived") }
    : { status: "done", icon: "circle-check", label: t("workforce.teams.inUse") };
}

/** Who may be chosen: current staff, never the member themselves, by name and job title. */
export function staffOptions(
  staff: readonly ({
    readonly id: string;
    readonly displayName: string;
    readonly jobTitle: string | null;
  } | null)[],
  except: readonly string[] = [],
): { value: string; label: string }[] {
  const skip = new Set(except);
  return staff
    .filter((s): s is NonNullable<typeof s> => s !== null && !skip.has(s.id))
    .map((s) => ({
      value: s.id,
      label: s.jobTitle ? `${s.displayName}, ${s.jobTitle}` : s.displayName,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "en-GB"));
}

/** Teams in use first, by name; archived last. */
export function sortTeams<T extends { readonly name: string; readonly archived: boolean }>(
  teams: readonly T[],
): T[] {
  return [...teams].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, "en-GB"),
  );
}

/** Current members first (the lead at the top), then ended ones, newest first. */
export function sortMembers<
  T extends {
    readonly name: string;
    readonly isLead: boolean;
    readonly validFrom: string;
    readonly validTo: string | null;
  },
>(members: readonly T[]): T[] {
  const current = members
    .filter((m) => m.validTo === null)
    .sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name, "en-GB"));
  const ended = members
    .filter((m) => m.validTo !== null)
    .sort((a, b) => (b.validTo ?? "").localeCompare(a.validTo ?? ""));
  return [...current, ...ended];
}
