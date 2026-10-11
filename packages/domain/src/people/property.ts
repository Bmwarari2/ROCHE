import { hasReason, isCalendarDate } from "./dates";
import type { PersonStatus } from "./lifecycle";

/**
 * Personal property inventory, valuables and keys (master prompt section 9.2; Regulation 13
 * protects people from financial abuse; people.md section 4 rule 7). Every item in is described,
 * dated and acknowledged by the person or their representative; valuables and items the person
 * could not sign for are witnessed by a second member of staff. Every item out (returned,
 * disposed of or lost) is recorded once, with who received it. Cash is never an inventory item:
 * residents' money is held in the residents' money ledger (finance), with its own two-person rules.
 */

export const PROPERTY_CATEGORIES = [
  "clothing",
  "jewellery",
  "watch",
  "electronics",
  "mobility_aid",
  "sensory_aid",
  "dentures",
  "documents",
  "furniture",
  "ornament_or_picture",
  "toiletries",
  "other",
] as const;
export type PropertyCategory = (typeof PROPERTY_CATEGORIES)[number];

/** Categories always treated as valuables (witnessed in and out). */
export const VALUABLE_CATEGORIES: readonly PropertyCategory[] = [
  "jewellery",
  "watch",
  "electronics",
  "documents",
];

/** Items that travel with the person to hospital (red bag: glasses, hearing aids, dentures, walking aids). */
export const TRAVELS_WITH_PERSON_CATEGORIES: readonly PropertyCategory[] = [
  "sensory_aid",
  "dentures",
  "mobility_aid",
];

export const MIN_PROPERTY_REASON_LENGTH = 3;

export interface PropertySignature {
  readonly signer: "person" | "representative" | "unable_to_sign";
  /** The signer's typed name (person or representative). */
  readonly name?: string | null;
  /** Why the person or representative could not sign. */
  readonly unableReason?: string | null;
  readonly signedAt: Date;
}

export interface PropertyItemIn {
  readonly description: string;
  /** A category, or any other text (refused when it names cash). */
  readonly category: string;
  readonly quantity: number;
  /** Marked a valuable by staff even if its category is not one (for example a painting). */
  readonly valuable?: boolean;
  readonly photoDocumentIds?: readonly string[];
  readonly receivedOn: string;
  readonly recordedBy: string;
  readonly acknowledgement: PropertySignature;
  readonly witnessedBy?: string | null;
}

export type PropertyProblem =
  | "description_required"
  | "cash_not_allowed"
  | "unknown_category"
  | "quantity_invalid"
  | "invalid_date"
  | "signer_name_required"
  | "unable_reason_required"
  | "witness_required"
  | "witness_same_as_recorder"
  | "already_closed"
  | "returned_before_received"
  | "recipient_required"
  | "recipient_not_entitled"
  | "reason_required"
  | "incident_required";

export type PropertyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly PropertyProblem[] };

function isCategory(value: string): value is PropertyCategory {
  return (PROPERTY_CATEGORIES as readonly string[]).includes(value);
}

export function isValuable(item: {
  readonly category: string;
  readonly valuable?: boolean;
}): boolean {
  return (
    item.valuable === true ||
    (isCategory(item.category) && VALUABLE_CATEGORIES.includes(item.category))
  );
}

function signatureProblems(signature: PropertySignature): PropertyProblem[] {
  if (signature.signer === "unable_to_sign") {
    return hasReason(signature.unableReason, MIN_PROPERTY_REASON_LENGTH)
      ? []
      : ["unable_reason_required"];
  }
  return hasReason(signature.name, 1) ? [] : ["signer_name_required"];
}

function witnessProblems(
  needsWitness: boolean,
  actor: string,
  witness: string | null | undefined,
): PropertyProblem[] {
  if (!needsWitness) return [];
  if (!witness) return ["witness_required"];
  return witness === actor ? ["witness_same_as_recorder"] : [];
}

function result(problems: PropertyProblem[]): PropertyCheck {
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Checks an item being recorded into the inventory. */
export function checkPropertyItemIn(item: PropertyItemIn): PropertyCheck {
  const problems: PropertyProblem[] = [];
  if (!hasReason(item.description, MIN_PROPERTY_REASON_LENGTH))
    problems.push("description_required");
  const category = item.category.trim().toLowerCase();
  if (/\b(cash|money|banknotes?|coins?)\b/.test(category)) problems.push("cash_not_allowed");
  else if (!isCategory(category)) problems.push("unknown_category");
  if (!Number.isInteger(item.quantity) || item.quantity < 1) problems.push("quantity_invalid");
  if (!isCalendarDate(item.receivedOn)) problems.push("invalid_date");
  problems.push(...signatureProblems(item.acknowledgement));
  const needsWitness = isValuable(item) || item.acknowledgement.signer === "unable_to_sign";
  problems.push(...witnessProblems(needsWitness, item.recordedBy, item.witnessedBy));
  return result(problems);
}

export const PROPERTY_ITEM_STATUSES = [
  "held",
  "sent_with_person",
  "returned",
  "disposed",
  "lost",
] as const;
export type PropertyItemStatus = (typeof PROPERTY_ITEM_STATUSES)[number];

export interface PropertyItemRecord {
  readonly id: string;
  readonly category: string;
  readonly valuable?: boolean;
  readonly receivedOn: string;
  readonly status: PropertyItemStatus;
}

export const RECIPIENT_CAPACITIES = [
  "person",
  "representative",
  "personal_representative",
  "receiving_provider",
] as const;
export type RecipientCapacity = (typeof RECIPIENT_CAPACITIES)[number];

export interface PropertyReturn {
  readonly returnedOn: string;
  readonly returnedBy: string;
  readonly recipientName: string;
  readonly recipientCapacity: RecipientCapacity;
  readonly signature: PropertySignature;
  readonly witnessedBy?: string | null;
}

/**
 * Checks the return of an item. After a death, property goes only to the personal representative
 * (executor or administrator) or the person the home's policy names as entitled; never to "the
 * person".
 */
export function checkPropertyReturn(
  item: PropertyItemRecord,
  ret: PropertyReturn,
  personStatus: PersonStatus,
): PropertyCheck {
  const problems: PropertyProblem[] = [];
  if (item.status !== "held" && item.status !== "sent_with_person") problems.push("already_closed");
  if (!isCalendarDate(ret.returnedOn)) problems.push("invalid_date");
  else if (ret.returnedOn < item.receivedOn) problems.push("returned_before_received");
  if (!hasReason(ret.recipientName, 1)) problems.push("recipient_required");
  if (personStatus === "deceased" && ret.recipientCapacity !== "personal_representative") {
    problems.push("recipient_not_entitled");
  }
  problems.push(...signatureProblems(ret.signature));
  const needsWitness = isValuable(item) || ret.signature.signer === "unable_to_sign";
  problems.push(...witnessProblems(needsWitness, ret.returnedBy, ret.witnessedBy));
  return result(problems);
}

export interface PropertyDisposal {
  readonly on: string;
  readonly by: string;
  readonly reason: string;
  readonly witnessedBy: string | null;
}

/** Disposal (for example worn-out clothing, with agreement) always needs a reason and a witness. */
export function checkPropertyDisposal(
  item: PropertyItemRecord,
  disposal: PropertyDisposal,
): PropertyCheck {
  const problems: PropertyProblem[] = [];
  if (item.status !== "held") problems.push("already_closed");
  if (!isCalendarDate(disposal.on)) problems.push("invalid_date");
  else if (disposal.on < item.receivedOn) problems.push("returned_before_received");
  if (!hasReason(disposal.reason, MIN_PROPERTY_REASON_LENGTH)) problems.push("reason_required");
  problems.push(...witnessProblems(true, disposal.by, disposal.witnessedBy));
  return result(problems);
}

/** A lost item is recorded with the incident raised for it (safety module). */
export function checkPropertyLoss(
  item: PropertyItemRecord,
  loss: { readonly on: string; readonly incidentId: string | null },
): PropertyCheck {
  const problems: PropertyProblem[] = [];
  if (item.status !== "held" && item.status !== "sent_with_person") problems.push("already_closed");
  if (!isCalendarDate(loss.on)) problems.push("invalid_date");
  if (!loss.incidentId) problems.push("incident_required");
  return result(problems);
}

/** Items still in the home's care or away with the person: they must be returned before closure. */
export function outstandingProperty<T extends PropertyItemRecord>(items: readonly T[]): T[] {
  return items.filter((i) => i.status === "held" || i.status === "sent_with_person");
}

/** Items that went to hospital with the person and have not been checked back in. */
export function propertyAwayWithPerson<T extends PropertyItemRecord>(items: readonly T[]): T[] {
  return items.filter((i) => i.status === "sent_with_person");
}

/** Held items of the kinds that should travel with the person to hospital. */
export function propertyToSendWithPerson<T extends PropertyItemRecord>(items: readonly T[]): T[] {
  return items.filter(
    (i) =>
      i.status === "held" &&
      isCategory(i.category) &&
      TRAVELS_WITH_PERSON_CATEGORIES.includes(i.category),
  );
}

// ------------------------------------------------------------------------------------------------
// Keys
// ------------------------------------------------------------------------------------------------

export interface KeyIssue {
  readonly id: string;
  readonly label: string;
  readonly issuedOn: string;
  readonly issuedTo: "person" | "representative";
  readonly returnedOn: string | null;
  readonly reportedLostOn: string | null;
}

/** Keys and fobs not yet returned or reported lost. */
export function outstandingKeys(keys: readonly KeyIssue[]): KeyIssue[] {
  return keys.filter((k) => k.returnedOn === null && k.reportedLostOn === null);
}
