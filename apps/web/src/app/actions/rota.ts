"use server";

import type { AssignmentResult, EligibilityItem, RotaItem, ShiftKind } from "@harbour/contracts";
import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { ROTA_PAGE } from "@/lib/rota";

/**
 * The rota builder's writes (scheduling.md section 14; SCHED-001, SCHED-002; HZ-123, HZ-124):
 * templates and patterns, rotas and shifts, assigning with the rostering rule and a manager's
 * justified override, the check before publishing and publishing with each period acknowledged.
 * The API checks the permissions, the location and every rule again; the web keeps nothing.
 */

const uuids = (...ids: readonly string[]) => ids.every((id) => isUuid(id));

async function send<T>(
  ids: readonly string[],
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ActionResult<T>> {
  if (!uuids(...ids)) return refused(t("errors.notFound"), "not_found");
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok || data === undefined) return { ok: false, ...problemMessage(error, t) };
    revalidatePath(ROTA_PAGE, "layout");
    return { ok: true, data };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

export interface ShiftShape {
  readonly kind: ShiftKind;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly breakMinutes: number;
  readonly supervised: boolean;
  readonly countsAsCare: boolean;
}

export async function createShiftTemplate(
  locationId: string,
  body: ShiftShape & { readonly name: string },
): Promise<ActionResult<{ id: string }>> {
  return send([locationId], (api) =>
    api.POST("/v1/locations/{id}/shift-templates", {
      params: { path: { id: locationId } },
      body: { ...body, requiredCompetences: [], requiredSkills: [] },
    }),
  );
}

export async function archiveShiftTemplate(
  id: string,
  version: number,
): Promise<ActionResult<unknown>> {
  return send([id], (api) =>
    api.POST("/v1/shift-templates/{id}/archive", {
      params: { path: { id } },
      body: { version },
    }),
  );
}

export async function createShiftPattern(
  locationId: string,
  body: {
    readonly name: string;
    readonly cycleDays: number;
    readonly entries: readonly { day: number; templateId: string; count: number }[];
  },
): Promise<ActionResult<{ id: string }>> {
  if (!body.entries.every((e) => isUuid(e.templateId))) {
    return refused(t("errors.notFound"), "not_found");
  }
  return send([locationId], (api) =>
    api.POST("/v1/locations/{id}/shift-patterns", {
      params: { path: { id: locationId } },
      body: { ...body, entries: [...body.entries] },
    }),
  );
}

export async function archiveShiftPattern(
  id: string,
  version: number,
): Promise<ActionResult<unknown>> {
  return send([id], (api) =>
    api.POST("/v1/shift-patterns/{id}/archive", {
      params: { path: { id } },
      body: { version },
    }),
  );
}

export async function startRota(
  locationId: string,
  startsOn: string,
  endsOn: string,
): Promise<ActionResult<RotaItem>> {
  return send([locationId], (api) =>
    api.POST("/v1/locations/{id}/rotas", {
      params: { path: { id: locationId } },
      body: { startsOn, endsOn },
    }),
  );
}

export async function applyPattern(
  rotaId: string,
  patternId: string,
  version: number,
): Promise<ActionResult<unknown>> {
  return send([rotaId, patternId], (api) =>
    api.POST("/v1/rotas/{id}/apply-pattern", {
      params: { path: { id: rotaId } },
      body: { patternId, version },
    }),
  );
}

export async function addShiftFromTemplate(
  rotaId: string,
  date: string,
  templateId: string,
): Promise<ActionResult<unknown>> {
  return send([rotaId, templateId], (api) =>
    api.POST("/v1/rotas/{id}/shifts", {
      params: { path: { id: rotaId } },
      body: { date, templateId },
    }),
  );
}

export async function cancelShift(
  shiftId: string,
  version: number,
  reason: string,
): Promise<ActionResult<unknown>> {
  return send([shiftId], (api) =>
    api.POST("/v1/shifts/{id}/cancel", {
      params: { path: { id: shiftId } },
      body: { version, reason },
    }),
  );
}

/** Whether a member may work a shift: the rostering rule's blockers in words (HZ-124). */
export async function shiftEligibility(
  shiftId: string,
  workerId: string,
): Promise<ActionResult<EligibilityItem>> {
  return send([shiftId, workerId], (api) =>
    api.GET("/v1/shifts/{id}/eligibility", {
      params: { path: { id: shiftId }, query: { workerId } },
    }),
  );
}

/**
 * Puts a member on a shift; with an override, the manager's justification and exactly the blocker
 * keys they were shown (the API refuses changed ones, and never overrides a right to work).
 */
export async function assignShift(
  shiftId: string,
  workerId: string,
  version: number,
  override?: { readonly justification: string; readonly blockerKeys: readonly string[] },
): Promise<ActionResult<AssignmentResult>> {
  return send([shiftId, workerId], (api) =>
    api.POST("/v1/shifts/{id}/assignment", {
      params: { path: { id: shiftId } },
      body: {
        workerId,
        version,
        ...(override
          ? {
              override: {
                justification: override.justification,
                blockerKeys: [...override.blockerKeys],
              },
            }
          : {}),
      },
    }),
  );
}

export async function removeAssignment(
  assignmentId: string,
  version: number,
  reason: string,
): Promise<ActionResult<unknown>> {
  return send([assignmentId], (api) =>
    api.POST("/v1/shift-assignments/{id}/remove", {
      params: { path: { id: assignmentId } },
      body: { version, reason },
    }),
  );
}

/** Publishes with the digest of the check the publisher saw and each period acknowledged. */
export async function publishRota(
  rotaId: string,
  body: {
    readonly version: number;
    readonly digest: string;
    readonly acknowledgeWarnings: boolean;
    readonly acknowledgedPeriods: readonly string[];
  },
): Promise<ActionResult<unknown>> {
  return send([rotaId], (api) =>
    api.POST("/v1/rotas/{id}/publish", {
      params: { path: { id: rotaId } },
      body: { ...body, acknowledgedPeriods: [...body.acknowledgedPeriods] },
    }),
  );
}
