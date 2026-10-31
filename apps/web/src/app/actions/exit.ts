"use server";

import type { ExitDetails, ExitView, PersonStatusChangeResult } from "@harbour/contracts";
import { optionalText, sendForPerson } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { isIsoInstant, ukToday } from "@/lib/uk-time";

/**
 * The Leaving tab's writes (PEOP-010): each goes to the API as the signed-in person, which checks
 * the permission, the workflow, step-up and separation of duties again. On success the person's
 * pages are read again, so the header's status and every tab show the change.
 */

/** The separation-of-duties refusal said for the exit, not for an incident. */
function exitWords<T>(result: ActionResult<T>): ActionResult<T> {
  if (!result.ok && result.code === "separation_of_duties") {
    return { ...result, message: t("people.exit.separationOfDuties") };
  }
  return result;
}

export interface LeavingInput {
  readonly exitKind: "discharge" | "transfer";
  readonly effectiveAt: string;
  readonly reason: string;
  readonly details: ExitDetails;
  readonly version: number;
}

/** Plan a discharge or transfer before the person leaves (people.admission.manage). */
export async function planExit(
  personId: string,
  input: { readonly kind: "discharge" | "transfer"; readonly details: ExitDetails },
): Promise<ActionResult<ExitView>> {
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/exit", {
      params: { path: { id: personId } },
      body: { kind: input.kind, details: input.details },
    }),
  );
}

/** Record that the person has left: a discharge or a transfer (people.admission.manage). */
export async function recordLeaving(
  personId: string,
  input: LeavingInput,
): Promise<ActionResult<PersonStatusChangeResult>> {
  if (!isIsoInstant(input.effectiveAt)) {
    return refused(t("people.exit.whenRequired"), "invalid", ["effectiveAt"]);
  }
  const reason = optionalText(input.reason);
  if (!reason) return refused(t("people.exit.reasonRequired"), "invalid", ["reason"]);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/status", {
      params: { path: { id: personId } },
      body: {
        to: "discharged",
        exitKind: input.exitKind,
        effectiveAt: input.effectiveAt,
        reason,
        exit: input.details,
        version: input.version,
      },
    }),
  );
}

/** Record a death (people.movement.record). */
export async function recordDeath(
  personId: string,
  input: { readonly effectiveAt: string; readonly details: ExitDetails; readonly version: number },
): Promise<ActionResult<PersonStatusChangeResult>> {
  if (!isIsoInstant(input.effectiveAt)) {
    return refused(t("people.exit.whenRequired"), "invalid", ["effectiveAt"]);
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/status", {
      params: { path: { id: personId } },
      body: {
        to: "deceased",
        effectiveAt: input.effectiveAt,
        exit: input.details,
        version: input.version,
      },
    }),
  );
}

/** An item done, not required with a reason, or to do again. */
export async function updateExitItem(
  personId: string,
  itemKey: string,
  input: {
    readonly status: "pending" | "done" | "not_required";
    readonly reason?: string;
    readonly version: number;
  },
): Promise<ActionResult<ExitView>> {
  const reason = optionalText(input.reason);
  if (input.status === "not_required" && !reason) {
    return refused(t("people.exit.notRequiredReasonRequired"), "invalid", ["reason"]);
  }
  return exitWords(
    await sendForPerson(personId, (api) =>
      api.PUT("/v1/people/{id}/exit/items/{itemKey}", {
        params: { path: { id: personId, itemKey } },
        body: {
          status: input.status,
          ...(input.status === "not_required" && reason ? { reason } : {}),
          version: input.version,
        },
      }),
    ),
  );
}

/** Waiting for returns, closed, or a planned exit cancelled with a reason. */
export async function moveExit(
  personId: string,
  input: {
    readonly to: "awaiting_return" | "closed" | "cancelled";
    readonly reason?: string;
    readonly version: number;
  },
): Promise<ActionResult<ExitView>> {
  const reason = optionalText(input.reason);
  if (input.to === "cancelled" && !reason) {
    return refused(t("people.exit.cancelReasonRequired"), "invalid", ["reason"]);
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/exit/moves", {
      params: { path: { id: personId } },
      body: { to: input.to, ...(reason ? { reason } : {}), version: input.version },
    }),
  );
}

/** Archive the record once the exit has closed (people.admission.manage). "Now" is the server's. */
export async function archiveRecord(
  personId: string,
  input: { readonly version: number },
): Promise<ActionResult<PersonStatusChangeResult>> {
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/status", {
      params: { path: { id: personId } },
      body: { to: "archived", effectiveAt: new Date().toISOString(), version: input.version },
    }),
  );
}

export interface PropertyReturnInput {
  readonly recipientName: string;
  readonly recipientCapacity:
    | "person"
    | "representative"
    | "personal_representative"
    | "receiving_provider";
  readonly signer: "person" | "representative" | "unable_to_sign";
  readonly signerName: string;
  readonly unableReason: string;
  readonly version: number;
}

/** An item of property returned today, with who received it and who signed. */
export async function returnProperty(
  personId: string,
  itemId: string,
  input: PropertyReturnInput,
): Promise<ActionResult<unknown>> {
  if (!isUuid(itemId)) return refused(t("errors.notFound"), "not_found");
  const recipientName = optionalText(input.recipientName);
  const signerName = optionalText(input.signerName);
  const unableReason = optionalText(input.unableReason);
  const fields: Record<string, string> = {};
  if (!recipientName) fields.recipientName = t("people.exit.returns.recipientRequired");
  if (input.signer === "unable_to_sign" && !unableReason) {
    fields.unableReason = t("people.exit.returns.unableReasonRequired");
  }
  if (input.signer !== "unable_to_sign" && !signerName) {
    fields.signerName = t("people.exit.returns.signerNameRequired");
  }
  const first = Object.values(fields)[0];
  if (first) return refused(first, "invalid", fields);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/property/{itemId}/return", {
      params: { path: { id: personId, itemId } },
      body: {
        returnedOn: ukToday(),
        recipientName: recipientName ?? "",
        recipientCapacity: input.recipientCapacity,
        signature: {
          signer: input.signer,
          ...(input.signer === "unable_to_sign" ? { unableReason } : { name: signerName }),
          signedAt: new Date().toISOString(),
        },
        version: input.version,
      },
    }),
  );
}

/** A key returned today, or reported lost today. */
export async function closeKey(
  personId: string,
  keyId: string,
  input: { readonly outcome: "returned" | "lost"; readonly version: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(keyId)) return refused(t("errors.notFound"), "not_found");
  return sendForPerson(personId, (api) =>
    input.outcome === "returned"
      ? api.POST("/v1/people/{id}/keys/{keyId}/return", {
          params: { path: { id: personId, keyId } },
          body: { on: ukToday(), version: input.version },
        })
      : api.POST("/v1/people/{id}/keys/{keyId}/lost", {
          params: { path: { id: personId, keyId } },
          body: { on: ukToday(), version: input.version },
        }),
  );
}
