"use server";

import type {
  CreatePropertyItem,
  KeyIssueOut,
  PropertyItemOut,
  ReturnPropertyItem,
} from "@harbour/contracts";
import { unstable_rethrow } from "next/navigation";
import {
  MIN_PROPERTY_DESCRIPTION,
  MIN_REASON,
  needsWitness,
  PROPERTY_CATEGORY_OPTIONS,
  PROPERTY_DESCRIPTION_MAX,
  type Signer,
} from "@/lib/admission";
import { getShellContext, tenantApi } from "@/lib/api";
import { sendForPerson } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, fieldErrors, problemMessage, refused } from "@/lib/outcome";
import { isIsoDate } from "@/lib/uk-time";

/**
 * Property, valuables and keys (people.md rule 7; Regulation 13), sent to the API as the signed-in
 * person with `people.property.manage`. The forms check first what the API will check again: a
 * description, a whole count, who signed or why nobody could, and a second member of staff as
 * witness for valuables and unsigned items, never the person recording. New items and keys carry
 * the form's own id, so sending again after a lost connection never records them twice.
 */

const SIGNERS = new Set<Signer>(["person", "representative", "unable_to_sign"]);
const CAPACITIES = new Set([
  "person",
  "representative",
  "personal_representative",
  "receiving_provider",
]);

export interface SignatureInput {
  readonly signer: Signer | null;
  readonly name: string;
  readonly unableReason: string;
}

function signatureProblems(signature: SignatureInput, prefix: string): Record<string, string> {
  if (!signature.signer || !SIGNERS.has(signature.signer)) {
    return { [`${prefix}Signer`]: t("people.property.form.signerRequired") };
  }
  if (signature.signer === "unable_to_sign") {
    const reason = signature.unableReason.trim();
    return reason.length < MIN_REASON || reason.length > 500
      ? { [`${prefix}UnableReason`]: t("people.property.form.unableReasonRequired") }
      : {};
  }
  const name = signature.name.trim();
  return name.length < 1 || name.length > 200
    ? { [`${prefix}Name`]: t("people.property.form.signerNameRequired") }
    : {};
}

function signatureBody(signature: SignatureInput) {
  return {
    signer: signature.signer ?? "unable_to_sign",
    ...(signature.signer === "unable_to_sign"
      ? { unableReason: signature.unableReason.trim() }
      : { name: signature.name.trim() }),
    signedAt: new Date().toISOString(),
  };
}

function witnessProblems(
  required: boolean,
  witness: string | null,
  me: string,
): Record<string, string> {
  if (!required) return {};
  if (!witness || !isUuid(witness)) return { witness: t("people.property.form.witnessRequired") };
  return witness === me ? { witness: t("people.property.form.witnessNotYou") } : {};
}

async function myId(): Promise<string> {
  const { me } = await getShellContext();
  return me.tenantUserId;
}

export async function addPropertyItem(
  personId: string,
  input: {
    readonly id: string;
    readonly description: string;
    readonly category: string;
    readonly quantity: number | null;
    readonly valuable: boolean;
    readonly receivedOn: string;
    readonly acknowledgement: SignatureInput;
    readonly witness: string | null;
  },
): Promise<ActionResult<PropertyItemOut>> {
  if (!isUuid(input.id)) return refused(t("care.errors.invalid"));
  const problems: Record<string, string> = {};
  const description = input.description.trim();
  if (
    description.length < MIN_PROPERTY_DESCRIPTION ||
    description.length > PROPERTY_DESCRIPTION_MAX
  ) {
    problems.description = t("people.property.form.descriptionRequired");
  }
  if (!(PROPERTY_CATEGORY_OPTIONS as readonly string[]).includes(input.category)) {
    problems.category = t("people.property.form.categoryRequired");
  }
  if (input.quantity === null) problems.quantity = t("people.property.form.quantityRequired");
  if (!isIsoDate(input.receivedOn)) problems.receivedOn = t("people.property.form.dateRequired");
  Object.assign(problems, signatureProblems(input.acknowledgement, "ack"));
  const witnessed = needsWitness({
    category: input.category,
    valuable: input.valuable,
    signer: input.acknowledgement.signer,
  });
  Object.assign(problems, witnessProblems(witnessed, input.witness, await myId()));
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  const body: CreatePropertyItem = {
    id: input.id,
    description,
    category: input.category,
    quantity: input.quantity ?? 1,
    valuable: input.valuable,
    photoDocumentIds: [],
    receivedOn: input.receivedOn,
    acknowledgement: signatureBody(input.acknowledgement),
    ...(witnessed && input.witness ? { witnessedBy: input.witness } : {}),
  };
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/property", { params: { path: { id: personId } }, body }),
  );
}

export async function returnPropertyItem(
  personId: string,
  itemId: string,
  input: {
    readonly returnedOn: string;
    readonly recipientName: string;
    readonly recipientCapacity: string | null;
    readonly signature: SignatureInput;
    readonly witness: string | null;
    /** Whether the item is a valuable (from the record), so the witness is asked for. */
    readonly valuable: boolean;
    readonly version: number;
  },
): Promise<ActionResult<PropertyItemOut>> {
  if (!isUuid(itemId) || !Number.isInteger(input.version)) return refused(t("care.errors.invalid"));
  const problems: Record<string, string> = {};
  if (!isIsoDate(input.returnedOn)) problems.returnedOn = t("people.property.form.dateRequired");
  const recipient = input.recipientName.trim();
  if (recipient.length < 1 || recipient.length > 200) {
    problems.recipientName = t("people.property.return.recipientRequired");
  }
  if (!input.recipientCapacity || !CAPACITIES.has(input.recipientCapacity)) {
    problems.recipientCapacity = t("people.property.return.capacityRequired");
  }
  Object.assign(problems, signatureProblems(input.signature, "return"));
  const witnessed = input.valuable || input.signature.signer === "unable_to_sign";
  Object.assign(problems, witnessProblems(witnessed, input.witness, await myId()));
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/property/{itemId}/return", {
      params: { path: { id: personId, itemId } },
      body: {
        returnedOn: input.returnedOn,
        recipientName: recipient,
        recipientCapacity: input.recipientCapacity as ReturnPropertyItem["recipientCapacity"],
        signature: signatureBody(input.signature),
        ...(witnessed && input.witness ? { witnessedBy: input.witness } : {}),
        version: input.version,
      },
    }),
  );
}

export async function disposePropertyItem(
  personId: string,
  itemId: string,
  input: {
    readonly on: string;
    readonly reason: string;
    readonly witness: string | null;
    readonly version: number;
  },
): Promise<ActionResult<PropertyItemOut>> {
  if (!isUuid(itemId) || !Number.isInteger(input.version)) return refused(t("care.errors.invalid"));
  const problems: Record<string, string> = {};
  if (!isIsoDate(input.on)) problems.on = t("people.property.form.dateRequired");
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON || reason.length > 500) {
    problems.reason = t("people.property.dispose.reasonRequired");
  }
  Object.assign(problems, witnessProblems(true, input.witness, await myId()));
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/property/{itemId}/dispose", {
      params: { path: { id: personId, itemId } },
      body: { on: input.on, reason, witnessedBy: input.witness ?? "", version: input.version },
    }),
  );
}

export async function losePropertyItem(
  personId: string,
  itemId: string,
  input: { readonly on: string; readonly incidentId: string | null; readonly version: number },
): Promise<ActionResult<PropertyItemOut>> {
  if (!isUuid(itemId) || !Number.isInteger(input.version)) return refused(t("care.errors.invalid"));
  const problems: Record<string, string> = {};
  if (!isIsoDate(input.on)) problems.on = t("people.property.form.dateRequired");
  if (!input.incidentId || !isUuid(input.incidentId)) {
    problems.incidentId = t("people.property.lose.incidentRequired");
  }
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/property/{itemId}/lose", {
      params: { path: { id: personId, itemId } },
      body: { on: input.on, incidentId: input.incidentId ?? "", version: input.version },
    }),
  );
}

export async function issueKey(
  personId: string,
  input: {
    readonly id: string;
    readonly label: string;
    readonly issuedOn: string;
    readonly issuedTo: string | null;
  },
): Promise<ActionResult<KeyIssueOut>> {
  if (!isUuid(input.id)) return refused(t("care.errors.invalid"));
  const problems: Record<string, string> = {};
  const label = input.label.trim();
  if (label.length < 1 || label.length > 120) problems.label = t("people.keys.form.labelRequired");
  if (!isIsoDate(input.issuedOn)) problems.issuedOn = t("people.property.form.dateRequired");
  if (input.issuedTo !== "person" && input.issuedTo !== "representative") {
    problems.issuedTo = t("people.keys.form.issuedToRequired");
  }
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/keys", {
      params: { path: { id: personId } },
      body: {
        id: input.id,
        label,
        issuedOn: input.issuedOn,
        issuedTo: input.issuedTo as "person",
      },
    }),
  );
}

export async function closeKey(
  personId: string,
  keyId: string,
  how: "returned" | "lost",
  input: { readonly on: string; readonly version: number },
): Promise<ActionResult<KeyIssueOut>> {
  if (!isUuid(keyId) || !Number.isInteger(input.version)) return refused(t("care.errors.invalid"));
  if (!isIsoDate(input.on)) {
    return refused(t("people.property.form.dateRequired"), "invalid", ["on"]);
  }
  return sendForPerson(personId, (api) =>
    how === "returned"
      ? api.POST("/v1/people/{id}/keys/{keyId}/return", {
          params: { path: { id: personId, keyId } },
          body: { on: input.on, version: input.version },
        })
      : api.POST("/v1/people/{id}/keys/{keyId}/lost", {
          params: { path: { id: personId, keyId } },
          body: { on: input.on, version: input.version },
        }),
  );
}

export interface WitnessOption {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly string[];
}

/**
 * Colleagues who could witness, found by name with the API's search of staff (in the scope the
 * user may find colleagues in; PLAT-013). The words go in the request body only. The person
 * recording is never offered: the witness must be someone else (rule 7).
 */
export async function findWitness(query: string): Promise<ActionResult<WitnessOption[]>> {
  const words = query.trim();
  if (words.length < 2 || words.length > 100) {
    return refused(t("people.property.witness.queryRequired"), "invalid", ["witnessQuery"]);
  }
  try {
    const api = await tenantApi();
    const me = await myId();
    const { data, error } = await api.POST("/v1/search", {
      body: { query: words, types: ["staff"] },
    });
    if (!data) return { ok: false, ...problemMessage(error, t) };
    return {
      ok: true,
      data: data.items
        .filter((item) => item.type === "staff" && item.staff && item.id !== me)
        .map((item) => ({
          id: item.id,
          name: item.staff?.name ?? "",
          roles: item.staff?.roles ?? [],
        })),
    };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}
