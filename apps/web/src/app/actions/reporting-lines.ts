"use server";

import { CreateStaffTeam, SetLineManager } from "@harbour/contracts";
import type { ApiClient } from "@harbour/contracts/client";
import type { MessageKey } from "@harbour/i18n";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import type { WorkforceValues } from "@/lib/workforce";

/**
 * Reporting lines' writes (ADR-0137, PR 2): a member's line manager and staff teams. Each goes to
 * the API as the signed-in person, which allows organisation-wide HR only (403
 * reporting_lines_organisation_wide), checks the version loaded and every rule again, and audits
 * it. Server actions are public endpoints, so every bound argument and value is checked here
 * before it is sent; refusals are said in the catalogue's words, with how to put them right.
 */

type Values = WorkforceValues;

/** Each reporting-lines refusal: its words (how to put it right) and the field it is about. */
const REFUSALS: Readonly<Record<string, { key: MessageKey; field: string | null }>> = {
  reporting_lines_organisation_wide: { key: "workforce.reporting.refusal.hrOnly", field: null },
  line_manager_is_member: { key: "workforce.reporting.refusal.self", field: "managerId" },
  not_current_staff: { key: "workforce.reporting.refusal.notCurrentStaff", field: null },
  starts_too_early: { key: "workforce.reporting.refusal.startsTooEarly", field: "from" },
  team_name_taken: { key: "workforce.reporting.refusal.nameTaken", field: "name" },
  team_archived: { key: "workforce.reporting.refusal.teamArchived", field: null },
  already_a_member: { key: "workforce.reporting.refusal.alreadyMember", field: "memberId" },
  membership_ended: { key: "workforce.reporting.refusal.membershipEnded", field: null },
  ends_too_early: { key: "workforce.reporting.refusal.endsTooEarly", field: "endsOn" },
};

function reportingProblem(error: unknown) {
  const problem = (error ?? {}) as { code?: unknown };
  const code = typeof problem.code === "string" ? problem.code : "";
  const known = REFUSALS[code];
  if (!known) return problemMessage(error, t);
  const message = t(known.key);
  return known.field ? { code, message, fields: { [known.field]: message } } : { code, message };
}

async function send<T>(
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown }>,
): Promise<ActionResult<T>> {
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      revalidatePath("/workforce", "layout");
      return { ok: true, data };
    }
    return { ok: false, ...reportingProblem(error) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const str = (v: Values, k: string): string | null => {
  const value = v[k];
  return typeof value === "string" && value !== "" ? value : null;
};
const bad = (): ActionResult<never> => refused(t("workforce.form.notFound"), "not_found");
const malformed = (): ActionResult<never> => refused(t("care.errors.invalid"), "invalid");
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
/** The contract's own checks: a real ISO calendar date, and a team name of 2 to 120 characters. */
const IsoDate = SetLineManager.shape.from;
const TeamName = CreateStaffTeam.shape.name;

/** A date field's value, when it is a real calendar date. */
function dateOf(values: Values, field: string): string | null {
  const parsed = IsoDate.safeParse(str(values, field));
  return parsed.success ? parsed.data : null;
}
const badDate = (field: string) =>
  refused(t("workforce.reporting.refusal.date"), "invalid", [field]);
const badName = () => refused(t("workforce.reporting.refusal.name"), "invalid", ["name"]);
const location = (values: Values): string | null | false => {
  const value = str(values, "locationId");
  return value === null ? null : isUuid(value) ? value : false;
};

/** Names a new line manager from the day given; the current line, if any, ends that day. */
export async function setLineManager(
  memberId: string,
  expectedVersion: number | null,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId)) return bad();
  if (expectedVersion !== null && !isVersion(expectedVersion)) return malformed();
  const managerId = str(values, "managerId") ?? "";
  if (!isUuid(managerId)) {
    return refused(t("workforce.lineManager.chooseManager"), "invalid", ["managerId"]);
  }
  const from = dateOf(values, "from");
  if (!from) return badDate("from");
  return send((api) =>
    api.PUT("/v1/workforce/members/{memberId}/line-manager", {
      params: { path: { memberId } },
      body: { managerId, from, expectedVersion },
    }),
  );
}

/** Ends the current line from the day given, with no successor. */
export async function endLineManager(
  memberId: string,
  expectedVersion: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(memberId)) return bad();
  if (!isVersion(expectedVersion)) return malformed();
  const from = dateOf(values, "from");
  if (!from) return badDate("from");
  return send((api) =>
    api.PUT("/v1/workforce/members/{memberId}/line-manager", {
      params: { path: { memberId } },
      body: { managerId: null, from, expectedVersion },
    }),
  );
}

export async function createTeam(values: Values): Promise<ActionResult<unknown>> {
  const name = TeamName.safeParse(str(values, "name") ?? "");
  if (!name.success) return badName();
  const locationId = location(values);
  if (locationId === false) return bad();
  return send((api) => api.POST("/v1/workforce/teams", { body: { name: name.data, locationId } }));
}

/** Renames a team, or moves it to another home, keeping it in use. */
export async function changeTeam(
  teamId: string,
  expectedVersion: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(teamId)) return bad();
  if (!isVersion(expectedVersion)) return malformed();
  const name = TeamName.safeParse(str(values, "name") ?? "");
  if (!name.success) return badName();
  const locationId = location(values);
  if (locationId === false) return bad();
  return send((api) =>
    api.PUT("/v1/workforce/teams/{teamId}", {
      params: { path: { teamId } },
      body: { name: name.data, locationId, archived: false, expectedVersion },
    }),
  );
}

/**
 * Archives a team: it then widens no one's scope (ADR-0137). Only the version comes from the page;
 * the name and home are read again here, so this call can never rename or move the team.
 */
export async function archiveTeam(
  teamId: string,
  expectedVersion: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(teamId)) return bad();
  if (!isVersion(expectedVersion)) return malformed();
  if (values.confirm !== true) {
    return refused(t("workforce.teams.archiveConfirmRequired"), "invalid", ["confirm"]);
  }
  return send(async (api) => {
    const listed = await api.GET("/v1/workforce/teams");
    const team = listed.data?.teams.find((x) => x.id === teamId);
    if (!team) return { error: listed.error ?? { code: "not_found" } };
    return api.PUT("/v1/workforce/teams/{teamId}", {
      params: { path: { teamId } },
      body: { name: team.name, locationId: team.locationId, archived: true, expectedVersion },
    });
  });
}

export async function addTeamMember(
  teamId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(teamId)) return bad();
  const memberId = str(values, "memberId") ?? "";
  if (!isUuid(memberId)) {
    return refused(t("workforce.teams.chooseMember"), "invalid", ["memberId"]);
  }
  const from = dateOf(values, "from");
  if (!from) return badDate("from");
  return send((api) =>
    api.POST("/v1/workforce/teams/{teamId}/members", {
      params: { path: { teamId } },
      body: { memberId, isLead: values.isLead === true, from },
    }),
  );
}

/** Makes a current member the team's lead, or no longer the lead. */
export async function setTeamLead(
  teamId: string,
  membershipId: string,
  version: number,
  isLead: boolean,
  _values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(teamId) || !isUuid(membershipId)) return bad();
  if (!isVersion(version) || typeof isLead !== "boolean") return malformed();
  return send((api) =>
    api.PUT("/v1/workforce/teams/{teamId}/members/{membershipId}", {
      params: { path: { teamId, membershipId } },
      body: { isLead, endsOn: null, expectedVersion: version },
    }),
  );
}

/** Ends a membership from the day given. */
export async function endTeamMember(
  teamId: string,
  membershipId: string,
  version: number,
  isLead: boolean,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(teamId) || !isUuid(membershipId)) return bad();
  if (!isVersion(version) || typeof isLead !== "boolean") return malformed();
  const endsOn = dateOf(values, "endsOn");
  if (!endsOn) return badDate("endsOn");
  return send((api) =>
    api.PUT("/v1/workforce/teams/{teamId}/members/{membershipId}", {
      params: { path: { teamId, membershipId } },
      body: { isLead, endsOn, expectedVersion: version },
    }),
  );
}
