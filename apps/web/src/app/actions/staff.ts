"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import {
  type ComplianceInput,
  type ComplianceKind,
  PRIVACY_PAGE,
  RECORDABLE_KINDS,
  REPORT_KINDS,
  SPONSOR_PAGE,
  type SponsorInput,
  STAFF_PAGE,
  type StaffFileInput,
} from "@/lib/staff";

/**
 * The staff file, compliance, sponsor and privacy writes (slice 56). Each is sent to the API as
 * the signed-in person, which checks the permission, never one's own record, the version and
 * every rule again; the web app keeps nothing. Refusals come back in words.
 */

function refusalWords(code: unknown): string | null {
  switch (code) {
    case "own_staff_file":
      return t("staff.refused.ownFile");
    case "own_sponsor_record":
      return t("sponsor.refused.own");
    case "staff_file_exists":
      return t("staff.refused.exists");
    case "already_recorded":
      return t("sponsor.refused.exists");
    case "notice_version_changed":
      return t("privacy.refused.versionChanged");
    default:
      return null;
  }
}

function problemOf(error: unknown): ActionResult<never> {
  const code = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown };
  const words = refusalWords(code.code);
  if (words) return refused(words, String(code.code));
  return { ok: false, ...problemMessage(error, t) };
}

async function withApi<T>(fn: (api: ApiClient) => Promise<ActionResult<T>>) {
  try {
    return await fn(await tenantApi());
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false as const, ...problemMessage(undefined, t) };
  }
}

const notFound = () => refused(t("errors.notFound"), "not_found");
/** Server actions can be called with anything: refuse what is not an object before reading it. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const version = (v: number) => Number.isInteger(v) && v >= 1;

export async function createStaffFile(
  input: StaffFileInput & { readonly tenantUserId: string },
): Promise<ActionResult<{ id: string }>> {
  if (!isObject(input)) return notFound();
  if (!isUuid(input.tenantUserId) || (input.locationId && !isUuid(input.locationId)))
    return notFound();
  return withApi<{ id: string }>(async (api) => {
    const { data, error } = await api.POST("/v1/workforce/staff-files", { body: input });
    if (!data) return problemOf(error);
    revalidatePath(STAFF_PAGE, "layout");
    return { ok: true, data: { id: data.id } };
  });
}

export async function updateStaffFile(
  id: string,
  expectedVersion: number,
  input: StaffFileInput,
): Promise<ActionResult<null>> {
  if (!isObject(input) || !isUuid(id) || !version(expectedVersion)) return notFound();
  if (input.locationId && !isUuid(input.locationId)) return notFound();
  const { tenantUserId: _ignored, ...profile } = input;
  return withApi<null>(async (api) => {
    const { data, error } = await api.PATCH("/v1/workforce/staff-files/{id}", {
      params: { path: { id } },
      body: { ...profile, expectedVersion },
    });
    if (!data) return problemOf(error);
    revalidatePath(STAFF_PAGE, "layout");
    return { ok: true, data: null };
  });
}

export async function recordComplianceItem(
  fileId: string,
  kind: ComplianceKind,
  expectedVersion: number | null,
  input: ComplianceInput,
): Promise<ActionResult<null>> {
  if (!isObject(input) || !isObject(input.detail)) return notFound();
  if (!isUuid(fileId) || !RECORDABLE_KINDS.includes(kind) || input.detail.kind !== kind)
    return notFound();
  if (expectedVersion !== null && !version(expectedVersion)) return notFound();
  return withApi<null>(async (api) => {
    const { data, error } = await api.PUT("/v1/workforce/staff-files/{id}/items/{kind}", {
      params: { path: { id: fileId, kind } },
      body: {
        detail: input.detail,
        verifiedOn: input.verifiedOn,
        ...(expectedVersion !== null ? { expectedVersion } : {}),
      },
    });
    if (!data) return problemOf(error);
    revalidatePath(`${STAFF_PAGE}/${fileId}`);
    return { ok: true, data: null };
  });
}

export async function createSponsoredWorker(
  input: SponsorInput & { readonly tenantUserId: string },
): Promise<ActionResult<{ id: string }>> {
  if (!isObject(input) || !isUuid(input.tenantUserId)) return notFound();
  const { endedOn: _ignored, ...body } = input;
  return withApi<{ id: string }>(async (api) => {
    const { data, error } = await api.POST("/v1/workforce/sponsored-workers", { body });
    if (!data) return problemOf(error);
    revalidatePath(SPONSOR_PAGE, "layout");
    return { ok: true, data: { id: data.id } };
  });
}

export async function updateSponsoredWorker(
  id: string,
  expectedVersion: number,
  input: SponsorInput,
): Promise<ActionResult<null>> {
  if (!isObject(input) || !isUuid(id) || !version(expectedVersion)) return notFound();
  const { tenantUserId: _ignored, endedOn, ...rest } = input;
  return withApi<null>(async (api) => {
    const { data, error } = await api.PUT("/v1/workforce/sponsored-workers/{id}", {
      params: { path: { id } },
      body: { ...rest, endedOn: endedOn ?? null, expectedVersion },
    });
    if (!data) return problemOf(error);
    revalidatePath(SPONSOR_PAGE, "layout");
    return { ok: true, data: null };
  });
}

export async function recordAbsence(
  workerId: string,
  input: { fromOn: string; toOn: string; authorised: boolean },
): Promise<ActionResult<null>> {
  if (!isObject(input) || !isUuid(workerId)) return notFound();
  if (!isDate(input.fromOn) || !isDate(input.toOn) || typeof input.authorised !== "boolean")
    return notFound();
  return withApi<null>(async (api) => {
    const { data, error } = await api.POST("/v1/workforce/sponsored-workers/{id}/absences", {
      params: { path: { id: workerId } },
      body: input,
    });
    if (!data) return problemOf(error);
    revalidatePath(SPONSOR_PAGE, "layout");
    return { ok: true, data: null };
  });
}

export async function recordReport(
  workerId: string,
  input: { kind: (typeof REPORT_KINDS)[number]; happenedOn: string },
): Promise<ActionResult<null>> {
  if (!isObject(input) || !isUuid(workerId) || !REPORT_KINDS.includes(input.kind))
    return notFound();
  if (!isDate(input.happenedOn)) return notFound();
  return withApi<null>(async (api) => {
    const { data, error } = await api.POST("/v1/workforce/sponsored-workers/{id}/reports", {
      params: { path: { id: workerId } },
      body: input,
    });
    if (!data) return problemOf(error);
    revalidatePath(SPONSOR_PAGE, "layout");
    return { ok: true, data: null };
  });
}
export async function markReported(
  reportId: string,
  expectedVersion: number,
  input: { reportedOn: string; smsReference: string },
): Promise<ActionResult<null>> {
  if (!isObject(input) || !isUuid(reportId) || !version(expectedVersion)) return notFound();
  if (!isDate(input.reportedOn) || typeof input.smsReference !== "string") return notFound();
  return withApi<null>(async (api) => {
    const { data, error } = await api.POST("/v1/workforce/sponsor-reports/{id}/reported", {
      params: { path: { id: reportId } },
      body: { ...input, expectedVersion },
    });
    if (!data) return problemOf(error);
    revalidatePath(SPONSOR_PAGE, "layout");
    return { ok: true, data: null };
  });
}

export async function setNoticeDocument(input: {
  documentId: string;
}): Promise<ActionResult<null>> {
  if (!isObject(input) || typeof input.documentId !== "string") return notFound();
  return withApi<null>(async (api) => {
    const { data, error } = await api.PUT("/v1/workforce/staff-privacy-notice", { body: input });
    if (!data) return problemOf(error);
    revalidatePath("/settings/data-protection");
    revalidatePath(PRIVACY_PAGE);
    return { ok: true, data: null };
  });
}

export async function acknowledgeNotice(noticeVersion: string): Promise<ActionResult<null>> {
  if (typeof noticeVersion !== "string" || noticeVersion.length < 1 || noticeVersion.length > 40)
    return notFound();
  return withApi<null>(async (api) => {
    const { data, error } = await api.POST("/v1/me/staff-privacy/acknowledgements", {
      body: { noticeVersion },
    });
    if (!data) return problemOf(error);
    revalidatePath(PRIVACY_PAGE);
    return { ok: true, data: null };
  });
}

const PURPOSES = ["newsletter", "website", "social_media", "family_feed"] as const;
const DECISIONS = ["given", "refused", "withdrawn"] as const;

export async function decideImageConsent(
  purpose: string,
  decision: string,
): Promise<ActionResult<null>> {
  const p = PURPOSES.find((x) => x === purpose);
  const d = DECISIONS.find((x) => x === decision);
  if (!p || !d) return notFound();
  return withApi<null>(async (api) => {
    const { data, error } = await api.POST("/v1/me/staff-image-consent", {
      body: { purpose: p, decision: d },
    });
    if (!data) return problemOf(error);
    revalidatePath(PRIVACY_PAGE);
    return { ok: true, data: null };
  });
}
