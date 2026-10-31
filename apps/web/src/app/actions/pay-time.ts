"use server";

import { sendAndRevalidate } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * Writes for the time, absence and pay screens (Phase 2 slice 60). The API checks every
 * permission, scope and rule again (separation of duties, organisation-wide pay, MFA); the web
 * keeps nothing of its own. Figures are never sent to or kept in the browser beyond the page.
 */

const bad = () => refused(t("errors.notFound"), "not_found");

export async function clockEvent(body: {
  id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  locationId: string;
  shiftId: string | null;
  deviceTime: string;
}): Promise<ActionResult<unknown>> {
  if (!isUuid(body.id) || !isUuid(body.locationId) || (body.shiftId && !isUuid(body.shiftId))) {
    return refused(t("care.errors.invalid"));
  }
  return sendAndRevalidate(["/my-time"], (api) =>
    api.POST("/v1/me/clock-events", {
      body: { ...body, deviceId: null, evidence: "none", nfcTagRef: null },
    }),
  );
}

export async function approveEntry(id: string, version: number): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  return sendAndRevalidate(["/timesheets"], (api) =>
    api.POST("/v1/timesheet-entries/{id}/approve", { params: { path: { id } }, body: { version } }),
  );
}

export async function requestLeave(body: {
  locationId: string;
  kind: string;
  startsOn: string;
  endsOn: string;
  selfCertified: boolean;
}): Promise<ActionResult<unknown>> {
  if (!isUuid(body.locationId)) return refused(t("care.errors.invalid"));
  return sendAndRevalidate(["/absences"], (api) =>
    api.POST("/v1/absences", {
      body: { ...body, kind: body.kind as "annual_leave" },
    }),
  );
}

export async function decideAbsence(
  id: string,
  body: { version: number; decision: "approve" | "decline"; reason?: string },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  return sendAndRevalidate(["/absences"], (api) =>
    api.POST("/v1/absences/{id}/decision", { params: { path: { id } }, body }),
  );
}

export async function createPayRun(body: {
  frequency: "weekly" | "monthly";
  periodStart: string;
  periodEnd: string;
}): Promise<ActionResult<{ id: string }>> {
  return sendAndRevalidate(["/pay"], (api) => api.POST("/v1/pay-runs", { body }));
}

export async function calculatePayRun(id: string, version: number): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-runs/{id}/calculate", { params: { path: { id } }, body: { version } }),
  );
}

export async function lockPayRun(id: string, version: number): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-runs/{id}/lock", { params: { path: { id } }, body: { version } }),
  );
}

export async function correctPayRun(id: string): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(id)) return bad();
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-runs/{id}/corrections", { params: { path: { id } } }),
  );
}

export async function overrideException(
  id: string,
  body: { version: number; reason: string },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-run-exceptions/{id}/override", { params: { path: { id } }, body }),
  );
}

export async function createRuleSet(body: {
  name: string;
  effectiveFrom: string;
  roleRates: Record<string, number>;
  sleepInFlatPence: number;
  mileagePencePerMile: number;
}): Promise<ActionResult<unknown>> {
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-rule-sets", {
      body: {
        ...body,
        enhancements: [],
        stackEnhancements: false,
        onCallFlatPence: 0,
        nightStartMinute: null,
        nightEndMinute: null,
        extraBankHolidays: [],
        overtimeAfterMinutes: null,
        rolledUpHoliday: false,
      },
    }),
  );
}

export async function approveRuleSet(id: string, version: number): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-rule-sets/{id}/approve", { params: { path: { id } }, body: { version } }),
  );
}
