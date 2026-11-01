import type { ShredRequestItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import {
  Ban,
  CircleCheck,
  CircleSlash,
  Hourglass,
  KeyRound,
  type LucideIcon,
  TimerOff,
} from "lucide-react";
import type { FormLike } from "./uk-time";

/**
 * Whole-organisation crypto-shredding screens (PLAT-012 part 2; platform.md, Crypto-shredding
 * screens rules 7 to 12; ADR-0109). Pure and unit tested. The API decides every rule (two people,
 * step-up, 7 days, the export, legal holds); these read the forms so a mistake is said at the field
 * before anything is sent, and word each request's state as an icon and a word.
 */

export const SHRED_PAGE = "/settings/retention/shred";
export const shredHref = (id: string) => `${SHRED_PAGE}/${id}`;
export const certificateHref = (id: string) => `/settings/retention/certificates/${id}`;
/** The API's limits (CreateShredRequest, RefuseShredRequest; packages/domain crypto-shred). */
export const SHRED_REASON_MIN = 20;
export const SHRED_REASON_MAX = 1000;
export const REFUSAL_REASON_MIN = 10;
export const REFUSAL_REASON_MAX = 500;
/** Typed before an approval (any case), so it is never one slip of a click. */
export const SHRED_CONFIRM_WORD = "shred";

export type ShredState = "pending" | "lapsed" | "shredding" | "approved" | "refused" | "cancelled";

/** The state a request is shown in: a pending one past its 7 days is lapsed. */
export function shredState(item: Pick<ShredRequestItem, "status" | "lapsed">): ShredState {
  return item.status === "pending" && item.lapsed ? "lapsed" : item.status;
}

/** Each state as an icon and a word (never colour alone), and the chip's status. */
export function shredChip(
  state: ShredState,
  t: Translator,
): { readonly status: StatusChipStatus; readonly icon: LucideIcon; readonly label: string } {
  const label = t("shred.state", { state });
  switch (state) {
    case "pending":
      return { status: "due", icon: Hourglass, label };
    case "lapsed":
      return { status: "notApplicable", icon: TimerOff, label };
    case "shredding":
      return { status: "info", icon: KeyRound, label };
    case "approved":
      return { status: "done", icon: CircleCheck, label };
    case "refused":
      return { status: "notApplicable", icon: Ban, label };
    case "cancelled":
      return { status: "notApplicable", icon: CircleSlash, label };
  }
}

/** Requests waiting or under way, which stop a new request (one at a time). */
export function openRequest(items: readonly ShredRequestItem[]): ShredRequestItem | null {
  return (
    items.find((i) => (i.status === "pending" && !i.lapsed) || i.status === "shredding") ?? null
  );
}

/** A member's name as the API gives it; one it cannot name is "a former member". */
export function memberName(name: string | null, t: Translator): string {
  return name ?? t("shred.formerMember");
}

/** What the person may do with a request now (the API decides again). */
export function shredActions(
  item: Pick<ShredRequestItem, "status" | "lapsed" | "requestedBy">,
  me: string,
): { readonly decide: boolean; readonly cancel: boolean; readonly withdraw: boolean } {
  const pending = item.status === "pending";
  const own = item.requestedBy === me;
  return {
    decide: pending && !item.lapsed && !own,
    cancel: pending && own,
    withdraw: pending && item.lapsed && !own,
  };
}

type Errors = Readonly<Record<string, string>>;
const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export type ShredRequestRead =
  | { readonly ok: true; readonly body: { readonly reason: string; readonly exportId: string } }
  | { readonly ok: false; readonly errors: Errors };

/** The request: one of the offered exports, a reason of 20 to 1,000 characters, the acknowledgement. */
export function readShredRequest(
  form: FormLike,
  t: Translator,
  offered: ReadonlySet<string>,
): ShredRequestRead {
  const errors: Record<string, string> = {};
  const exportId = text(form, "exportId");
  if (!offered.has(exportId)) errors.exportId = t("shred.request.exportError");
  const reason = text(form, "reason");
  if (reason.length < SHRED_REASON_MIN || reason.length > SHRED_REASON_MAX) {
    errors.reason = t("shred.request.reasonError", {
      min: SHRED_REASON_MIN,
      max: SHRED_REASON_MAX,
    });
  }
  if (text(form, "irreversible") !== "yes") errors.irreversible = t("shred.irreversibleError");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { reason, exportId } };
}

/** The approval: the confirmation word typed exactly, and the acknowledgement. */
export function readShredApproval(
  form: FormLike,
  t: Translator,
): { readonly ok: true } | { readonly ok: false; readonly errors: Errors } {
  const errors: Record<string, string> = {};
  if (text(form, "confirmWord").toLowerCase() !== SHRED_CONFIRM_WORD) {
    errors.confirmWord = t("shred.approve.wordError", { word: SHRED_CONFIRM_WORD });
  }
  if (text(form, "irreversible") !== "yes") errors.irreversible = t("shred.irreversibleError");
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true };
}

/** The refusal: a reason of 10 to 500 characters. */
export function readShredRefusal(
  form: FormLike,
  t: Translator,
):
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly errors: Errors } {
  const reason = text(form, "reason");
  if (reason.length < REFUSAL_REASON_MIN || reason.length > REFUSAL_REASON_MAX) {
    return {
      ok: false,
      errors: {
        reason: t("shred.refuse.reasonError", { min: REFUSAL_REASON_MIN, max: REFUSAL_REASON_MAX }),
      },
    };
  }
  return { ok: true, reason };
}

/** A certificate's signature check, as the verification route answers it. */
export function signatureChip(
  valid: boolean | null,
  t: Translator,
): { readonly status: StatusChipStatus; readonly icon: LucideIcon; readonly label: string } {
  const check = valid === true ? "valid" : valid === false ? "invalid" : "unsigned";
  const label = t("shred.certificate.check", { check });
  if (valid === true) return { status: "done", icon: CircleCheck, label };
  if (valid === false) return { status: "overdue", icon: Ban, label };
  return { status: "notRecorded", icon: CircleSlash, label };
}
