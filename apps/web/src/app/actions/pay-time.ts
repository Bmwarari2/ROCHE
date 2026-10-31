"use server";

import { sendAndRevalidate } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { ABSENCE_REQUEST_KINDS } from "@/lib/pay-time";

/**
 * Writes for the time, absence and pay screens (Phase 2 slice 60). The API checks every
 * permission, scope and rule again (separation of duties, organisation-wide pay, MFA); the web
 * keeps nothing of its own. Figures are never sent to or kept in the browser beyond the page.
 */

const bad = () => refused(t("errors.notFound"), "not_found");
const invalid = () => refused(t("care.errors.invalid"));

/**
 * Server actions are public POST endpoints: each builds the API body from named, checked fields
 * and never spreads what the caller sent. The API's schemas and permissions still decide.
 */
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isPence = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isText = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.trim().length >= min && v.trim().length <= max;
const CLOCK_KINDS = new Set(["in", "out", "break_start", "break_end"]);

export async function clockEvent(body: {
  id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  locationId: string;
  shiftId: string | null;
  deviceTime: string;
}): Promise<ActionResult<unknown>> {
  if (
    !isUuid(body.id) ||
    !isUuid(body.locationId) ||
    (body.shiftId !== null && !isUuid(body.shiftId)) ||
    !CLOCK_KINDS.has(body.kind) ||
    typeof body.deviceTime !== "string" ||
    Number.isNaN(Date.parse(body.deviceTime))
  ) {
    return invalid();
  }
  const { id, kind, locationId, shiftId, deviceTime } = body;
  return sendAndRevalidate(["/my-time"], (api) =>
    api.POST("/v1/me/clock-events", {
      body: {
        id,
        kind,
        locationId,
        shiftId,
        deviceTime,
        deviceId: null,
        evidence: "none",
        nfcTagRef: null,
      },
    }),
  );
}

export async function approveEntry(id: string, version: number): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  if (!isVersion(version)) return invalid();
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
  const kind = ABSENCE_REQUEST_KINDS.find((k) => k === body.kind);
  if (!isUuid(body.locationId) || !kind || !isDate(body.startsOn) || !isDate(body.endsOn)) {
    return invalid();
  }
  // Asking for one's own leave only: never self-certified sickness, never for someone else.
  return sendAndRevalidate(["/absences"], (api) =>
    api.POST("/v1/absences", {
      body: {
        locationId: body.locationId,
        kind,
        startsOn: body.startsOn,
        endsOn: body.endsOn,
        selfCertified: false,
      },
    }),
  );
}

export async function decideAbsence(
  id: string,
  body: { version: number; decision: "approve" | "decline"; reason?: string },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  if (
    !isVersion(body.version) ||
    (body.decision !== "approve" && body.decision !== "decline") ||
    (body.reason !== undefined && !isText(body.reason, 3, 500))
  ) {
    return invalid();
  }
  const { version, decision, reason } = body;
  return sendAndRevalidate(["/absences"], (api) =>
    api.POST("/v1/absences/{id}/decision", {
      params: { path: { id } },
      body: { version, decision, ...(reason !== undefined ? { reason } : {}) },
    }),
  );
}

export async function createPayRun(body: {
  frequency: "weekly" | "monthly";
  periodStart: string;
  periodEnd: string;
}): Promise<ActionResult<{ id: string }>> {
  if (
    (body.frequency !== "weekly" && body.frequency !== "monthly") ||
    !isDate(body.periodStart) ||
    !isDate(body.periodEnd)
  ) {
    return invalid();
  }
  const { frequency, periodStart, periodEnd } = body;
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-runs", { body: { frequency, periodStart, periodEnd } }),
  );
}

export async function calculatePayRun(id: string, version: number): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  if (!isVersion(version)) return invalid();
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-runs/{id}/calculate", { params: { path: { id } }, body: { version } }),
  );
}

export async function lockPayRun(id: string, version: number): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return bad();
  if (!isVersion(version)) return invalid();
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
  if (!isVersion(body.version) || !isText(body.reason, 3, 500)) return invalid();
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-run-exceptions/{id}/override", {
      params: { path: { id } },
      body: { version: body.version, reason: body.reason },
    }),
  );
}

export async function createRuleSet(body: {
  name: string;
  effectiveFrom: string;
  roleRates: Record<string, number>;
  sleepInFlatPence: number;
  mileagePencePerMile: number;
}): Promise<ActionResult<unknown>> {
  const rates = body.roleRates;
  if (
    !isText(body.name, 1, 120) ||
    !isDate(body.effectiveFrom) ||
    typeof rates !== "object" ||
    rates === null ||
    Object.keys(rates).length === 0 ||
    !Object.entries(rates).every(([k, v]) => /^[a-z][a-z0-9_]{0,59}$/.test(k) && isPence(v)) ||
    !isPence(body.sleepInFlatPence) ||
    !isPence(body.mileagePencePerMile)
  ) {
    return invalid();
  }
  const roleRates = Object.fromEntries(Object.entries(rates));
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-rule-sets", {
      body: {
        name: body.name,
        effectiveFrom: body.effectiveFrom,
        roleRates,
        sleepInFlatPence: body.sleepInFlatPence,
        mileagePencePerMile: body.mileagePencePerMile,
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
  if (!isVersion(version)) return invalid();
  return sendAndRevalidate(["/pay"], (api) =>
    api.POST("/v1/pay-rule-sets/{id}/approve", { params: { path: { id } }, body: { version } }),
  );
}
