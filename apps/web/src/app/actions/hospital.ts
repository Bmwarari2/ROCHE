"use server";

import type { HospitalTransferOut } from "@harbour/contracts";
import { optionalText, sendForPerson } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { MIN_INCOMPLETE_PACK_REASON_LENGTH, reasonLongEnough } from "@/lib/transfer-pack";
import { isIsoInstant } from "@/lib/uk-time";

/**
 * Writes for the hospital tab (people.md rule 10 and section 6a; PEOP-009; HZ-001, HZ-023). The
 * API assembles the pack from the record, refuses a pack for the wrong person and asks for the
 * named acknowledgement when an incomplete pack is handed over; every write is audited there.
 * `people.movement.record` (return checks: the check's own permission), checked again by the API.
 */

export interface SendInput {
  /** The transfer's own id (UUIDv7), kept across retries so a send sent twice records once. */
  readonly id: string;
  readonly hospitalName: string;
  readonly hospitalOdsCode: string;
  readonly leftAt: string;
  readonly reason: string;
  readonly sendItemIds: readonly string[];
  /** The person record's version, as the page read it. */
  readonly version: number;
}

export async function sendToHospital(
  personId: string,
  input: SendInput,
): Promise<ActionResult<HospitalTransferOut>> {
  const hospitalName = optionalText(input.hospitalName);
  if (!hospitalName) {
    return refused(t("people.transfer.send.hospitalRequired"), "invalid", ["hospitalName"]);
  }
  if (!isIsoInstant(input.leftAt)) {
    return refused(t("care.errors.whenRequired"), "invalid", ["leftAt"]);
  }
  if (!isUuid(input.id) || !input.sendItemIds.every((id) => isUuid(id))) {
    return refused(t("care.errors.invalid"));
  }
  const ods = optionalText(input.hospitalOdsCode);
  const reason = optionalText(input.reason);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/hospital-transfers", {
      params: { path: { id: personId } },
      body: {
        id: input.id,
        hospitalName,
        leftAt: input.leftAt,
        sendItemIds: [...input.sendItemIds],
        version: input.version,
        ...(ods ? { hospitalOdsCode: ods } : {}),
        ...(reason ? { reason } : {}),
      },
    }),
  );
}

export async function recordHandover(
  personId: string,
  transferId: string,
  input: { readonly acknowledgementReason: string | null; readonly version: number },
): Promise<ActionResult<HospitalTransferOut>> {
  if (!isUuid(transferId)) return refused(t("errors.notFound"), "not_found");
  const reason = input.acknowledgementReason?.trim() ?? null;
  if (reason !== null && !reasonLongEnough(reason)) {
    return refused(
      t("people.transfer.handover.reasonRequired", { min: MIN_INCOMPLETE_PACK_REASON_LENGTH }),
      "invalid",
      ["acknowledgementReason"],
    );
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/hospital-transfers/{transferId}/handover", {
      params: { path: { id: personId, transferId } },
      body: { version: input.version, ...(reason ? { acknowledgementReason: reason } : {}) },
    }),
  );
}

export async function recordReturn(
  personId: string,
  transferId: string,
  input: { readonly returnedAt: string; readonly version: number },
): Promise<ActionResult<HospitalTransferOut>> {
  if (!isUuid(transferId)) return refused(t("errors.notFound"), "not_found");
  if (!isIsoInstant(input.returnedAt)) {
    return refused(t("care.errors.whenRequired"), "invalid", ["returnedAt"]);
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/hospital-transfers/{transferId}/return", {
      params: { path: { id: personId, transferId } },
      body: { returnedAt: input.returnedAt, version: input.version },
    }),
  );
}

export async function completeReturnCheck(
  personId: string,
  transferId: string,
  checkKey: string,
  version: number,
): Promise<ActionResult<HospitalTransferOut>> {
  if (!isUuid(transferId) || !/^[a-z_]{1,80}$/.test(checkKey)) {
    return refused(t("errors.notFound"), "not_found");
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/hospital-transfers/{transferId}/return-checks/{checkKey}", {
      params: { path: { id: personId, transferId, checkKey } },
      body: { version },
    }),
  );
}
