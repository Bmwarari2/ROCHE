"use server";

import {
  ChangeHomelyProtocol,
  CheckHomelyDose,
  HomelyDoseEnteredInError,
  NewHomelyProtocol,
  RecordHomelyDose,
  WithdrawHomelyProtocol,
} from "@harbour/contracts";
import type { components } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  DOSE_FIELD_FOR_PROBLEM,
  type HomelyDoseCheck,
  PROTOCOL_FIELD_FOR_PROBLEM,
  personHomelyHref,
  protocolsHref,
} from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";
import { medicinesHref } from "@/lib/medicines";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Homely remedies on the web (slice 55; MEDS-007; medicines.md section 15.3; HZ-120). Each action
 * sends only the form's fields, checked against the contract first; the API runs every protocol and
 * dose rule (the rate table's limits, who is named, the gap, the 24 hours, the course, the same
 * product prescribed) and refuses in words, which are shown as they are, at their field where one
 * fits. The web keeps nothing and logs nothing.
 */

type Schemas = components["schemas"];

function homelyProblem(error: unknown, fields: Readonly<Record<string, string>>) {
  const problem = (error ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof problem.code === "string" ? problem.code : "";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  if (!detail || !code.startsWith("homely_")) return problemMessage(error, t);
  const field = fields[code];
  return field ? { code, message: detail, fields: { [field]: detail } } : { code, message: detail };
}

async function send<T>(
  call: () => Promise<{ data?: T; error?: unknown; response: Response }>,
  fields: Readonly<Record<string, string>>,
  paths: readonly string[],
): Promise<ActionResult<T | null>> {
  try {
    const { data, error, response } = await call();
    if (!response.ok) return { ok: false, ...homelyProblem(error, fields) };
    for (const path of paths) revalidatePath(path);
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Adds a protocol agreed with a GP or pharmacist at the home. */
export async function addProtocol(
  locationId: string,
  body: Schemas["NewHomelyProtocol"],
): Promise<ActionResult<null>> {
  if (!isUuid(locationId)) return refused(t("errors.notFound"), "not_found");
  const parsed = NewHomelyProtocol.safeParse(protocolFields(body));
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  const out = await send(
    async () =>
      (await tenantApi()).POST("/v1/locations/{id}/homely-remedies", {
        params: { path: { id: locationId } },
        body: parsed.data,
      }),
    PROTOCOL_FIELD_FOR_PROBLEM,
    [protocolsHref(locationId)],
  );
  return out.ok ? { ok: true, data: null } : out;
}

/** Changes a protocol with a new reason, at the version read. */
export async function changeProtocol(
  locationId: string,
  protocolId: string,
  body: Schemas["ChangeHomelyProtocol"],
): Promise<ActionResult<null>> {
  if (!isUuid(locationId) || !isUuid(protocolId)) {
    return refused(t("errors.notFound"), "not_found");
  }
  const parsed = ChangeHomelyProtocol.safeParse({
    ...protocolFields(body),
    reason: body.reason,
    version: body.version,
  });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  const out = await send(
    async () =>
      (await tenantApi()).POST("/v1/homely-remedies/{id}/change", {
        params: { path: { id: protocolId } },
        body: parsed.data,
      }),
    PROTOCOL_FIELD_FOR_PROBLEM,
    [protocolsHref(locationId)],
  );
  return out.ok ? { ok: true, data: null } : out;
}

/** Withdraws a protocol with a reason, at the version read; it is never used again. */
export async function withdrawProtocol(
  locationId: string,
  protocolId: string,
  body: Schemas["WithdrawHomelyProtocol"],
): Promise<ActionResult<null>> {
  if (!isUuid(locationId) || !isUuid(protocolId)) {
    return refused(t("errors.notFound"), "not_found");
  }
  const parsed = WithdrawHomelyProtocol.safeParse({ reason: body.reason, version: body.version });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  const out = await send(
    async () =>
      (await tenantApi()).POST("/v1/homely-remedies/{id}/withdraw", {
        params: { path: { id: protocolId } },
        body: parsed.data,
      }),
    {},
    [protocolsHref(locationId)],
  );
  return out.ok ? { ok: true, data: null } : out;
}

/** Checks a dose against the protocol now; records nothing. The answer is the API's words. */
export async function checkHomelyDose(
  personId: string,
  body: Schemas["CheckHomelyDose"],
): Promise<ActionResult<HomelyDoseCheck>> {
  if (!isUuid(personId)) return refused(t("errors.notFound"), "not_found");
  const parsed = CheckHomelyDose.safeParse({
    protocolId: body.protocolId,
    quantity: body.quantity,
  });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  const out = await send(
    async () =>
      (await tenantApi()).POST("/v1/people/{id}/homely-remedy-doses/check", {
        params: { path: { id: personId } },
        body: parsed.data,
      }),
    DOSE_FIELD_FOR_PROBLEM,
    [],
  );
  if (!out.ok) return out;
  return out.data ? { ok: true, data: out.data } : refused(t("errors.generic"), "unavailable");
}

/** Records a dose given now by the person signed in, with the allergies compared (HZ-007). */
export async function recordHomelyDose(
  personId: string,
  body: Schemas["RecordHomelyDose"],
): Promise<ActionResult<null>> {
  if (!isUuid(personId) || !isUuid(body?.id ?? ""))
    return refused(t("errors.notFound"), "not_found");
  // Only what the web form records: a dose now. A dose already given is not sent from here,
  // whatever a crafted call holds.
  const parsed = RecordHomelyDose.safeParse({
    id: body.id,
    protocolId: body.protocolId,
    quantity: body.quantity,
    reason: body.reason,
    allergiesChecked: body.allergiesChecked,
    alreadyGiven: null,
  });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  const out = await send(
    async () =>
      (await tenantApi()).POST("/v1/people/{id}/homely-remedy-doses", {
        params: { path: { id: personId } },
        body: parsed.data,
      }),
    DOSE_FIELD_FOR_PROBLEM,
    [personHomelyHref(personId), medicinesHref(personId)],
  );
  return out.ok ? { ok: true, data: null } : out;
}

/** Marks a dose entered in error with a reason; the dose stays, struck through. */
export async function markHomelyDoseInError(
  personId: string,
  doseId: string,
  body: Schemas["HomelyDoseEnteredInError"],
): Promise<ActionResult<null>> {
  if (!isUuid(personId) || !isUuid(doseId) || !isUuid(body?.id ?? "")) {
    return refused(t("errors.notFound"), "not_found");
  }
  const parsed = HomelyDoseEnteredInError.safeParse({ id: body.id, reason: body.reason });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  const out = await send(
    async () =>
      (await tenantApi()).POST("/v1/homely-remedy-doses/{id}/entered-in-error", {
        params: { path: { id: doseId } },
        body: parsed.data,
      }),
    {},
    [personHomelyHref(personId), medicinesHref(personId)],
  );
  return out.ok ? { ok: true, data: null } : out;
}

/** The protocol's own fields only, whatever else a crafted call holds. */
function protocolFields(body: Schemas["NewHomelyProtocol"]) {
  return {
    productName: body.productName,
    vmpId: body.vmpId,
    indication: body.indication,
    doseQuantity: body.doseQuantity,
    unitName: body.unitName,
    minIntervalHours: body.minIntervalHours,
    maxDailyQuantity: body.maxDailyQuantity,
    maxDays: body.maxDays,
    authorisedMemberIds: body.authorisedMemberIds,
    approvedByName: body.approvedByName,
    approvedByRole: body.approvedByRole,
    approvedOn: body.approvedOn,
    reviewOn: body.reviewOn,
  };
}
