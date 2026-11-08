"use server";

import type { ApiClient } from "@harbour/contracts/client";
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
 * it. Refusals come back in the API's own words. The web holds nothing of its own.
 */

type Values = WorkforceValues;

/** The reporting-lines refusals the API words itself, and the field each one is about. */
const FIELD_FOR: Readonly<Record<string, string | null>> = {
  reporting_lines_organisation_wide: null,
  line_manager_is_member: "managerId",
  not_current_staff: null,
  starts_too_early: "from",
  team_name_taken: "name",
  team_archived: null,
  already_a_member: "memberId",
  membership_ended: null,
  ends_too_early: "endsOn",
};

/** A refusal in the API's own sentence (its title, then its detail), at its field where it has one. */
function reportingProblem(error: unknown) {
  const problem = (error ?? {}) as { code?: unknown; title?: unknown; detail?: unknown };
  const code = typeof problem.code === "string" ? problem.code : "";
  if (!(code in FIELD_FOR)) return problemMessage(error, t);
  const title = typeof problem.title === "string" ? problem.title.trim() : "";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  const message = [title, detail].filter(Boolean).join(" ") || t("care.errors.invalid");
  const field = FIELD_FOR[code];
  return field ? { code, message, fields: { [field]: message } } : { code, message };
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
const req = (v: Values, k: string): string => str(v, k) ?? "";
const bad = (): ActionResult<never> => refused(t("workforce.form.notFound"), "not_found");

/** Names a new line manager from the day given; the current line, if any, ends that day. */
export async function setLineManager(
  memberId: string,
  expectedVersion: number | null,
  values: Values,
): Promise<ActionResult<unknown>> {
  const managerId = req(values, "managerId");
  if (!isUuid(memberId)) return bad();
  if (!isUuid(managerId)) {
    return refused(t("workforce.lineManager.chooseManager"), "invalid", ["managerId"]);
  }
  return send((api) =>
    api.PUT("/v1/workforce/members/{memberId}/line-manager", {
      params: { path: { memberId } },
      body: { managerId, from: req(values, "from"), expectedVersion },
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
  return send((api) =>
    api.PUT("/v1/workforce/members/{memberId}/line-manager", {
      params: { path: { memberId } },
      body: { managerId: null, from: req(values, "from"), expectedVersion },
    }),
  );
}

export async function createTeam(values: Values): Promise<ActionResult<unknown>> {
  const location = str(values, "locationId");
  if (location !== null && !isUuid(location)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/teams", {
      body: { name: req(values, "name"), locationId: location },
    }),
  );
}

/** Renames a team, or moves it to another home, keeping it in use. */
export async function changeTeam(
  teamId: string,
  expectedVersion: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  const location = str(values, "locationId");
  if (!isUuid(teamId) || (location !== null && !isUuid(location))) return bad();
  return send((api) =>
    api.PUT("/v1/workforce/teams/{teamId}", {
      params: { path: { teamId } },
      body: { name: req(values, "name"), locationId: location, archived: false, expectedVersion },
    }),
  );
}

/** Archives a team: it then widens no one's scope (ADR-0137). */
export async function archiveTeam(
  teamId: string,
  team: { readonly name: string; readonly locationId: string | null; readonly version: number },
  _values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(teamId)) return bad();
  return send((api) =>
    api.PUT("/v1/workforce/teams/{teamId}", {
      params: { path: { teamId } },
      body: {
        name: team.name,
        locationId: team.locationId,
        archived: true,
        expectedVersion: team.version,
      },
    }),
  );
}

export async function addTeamMember(
  teamId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  const memberId = req(values, "memberId");
  if (!isUuid(teamId)) return bad();
  if (!isUuid(memberId)) {
    return refused(t("workforce.teams.chooseMember"), "invalid", ["memberId"]);
  }
  return send((api) =>
    api.POST("/v1/workforce/teams/{teamId}/members", {
      params: { path: { teamId } },
      body: { memberId, isLead: values.isLead === true, from: req(values, "from") },
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
  return send((api) =>
    api.PUT("/v1/workforce/teams/{teamId}/members/{membershipId}", {
      params: { path: { teamId, membershipId } },
      body: { isLead, endsOn: req(values, "endsOn"), expectedVersion: version },
    }),
  );
}
