import type { LegalHoldItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { FormLike } from "./uk-time";

/**
 * Records retention (PLAT-012; platform.md, retention and legal hold; retention.md): the data
 * protection lead's legal holds, documents due for destruction and destruction certificates. Pure
 * and unit tested. Every retention route needs `platform.retention.manage` with a fresh step-up;
 * destruction is irreversible, so the form asks for a reason and an explicit acknowledgement, and
 * the API re-checks every id (a hold placed meanwhile, or a record no longer due, is skipped).
 */

export const RETENTION_PAGE = "/settings/retention";
export const RETENTION_PERMISSION = "platform.retention.manage";
/** The API's reason limits for holds and destruction (PlaceLegalHold, DestroyDocuments). */
export const RETENTION_REASON_MIN = 10;
export const RETENTION_REASON_MAX = 500;
/** The most documents the API destroys in one request (DestroyDocuments). */
export const DESTROY_MAX = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_TYPE = /^[a-z_]{1,60}$/;

/**
 * The kinds of record a hold on one record names, as the destruction engine checks them: today it
 * destroys documents only, so a hold on one record is a hold on a document.
 */
export const HOLD_RECORD_TYPES = ["document"] as const;

export function retentionShown(permissions: readonly string[]): boolean {
  return permissions.includes(RETENTION_PERMISSION);
}

/** Holds in force first, newest first; then released ones, most recently released first. */
export function splitHolds(items: readonly LegalHoldItem[]): {
  inForce: LegalHoldItem[];
  released: LegalHoldItem[];
} {
  const inForce = items
    .filter((h) => !h.releasedAt)
    .sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt));
  const released = items
    .filter((h) => h.releasedAt)
    .sort((a, b) => Date.parse(b.releasedAt ?? "") - Date.parse(a.releasedAt ?? ""));
  return { inForce, released };
}

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

type Errors = Readonly<Record<string, string>>;

function reasonError(reason: string, t: Translator, purpose: string): string | null {
  return reason.length < RETENTION_REASON_MIN || reason.length > RETENTION_REASON_MAX
    ? t("retention.reasonError", { purpose, min: RETENTION_REASON_MIN })
    : null;
}

export type PlaceHoldRead =
  | {
      readonly ok: true;
      readonly body: {
        readonly personId?: string;
        readonly subjectType?: string;
        readonly subjectId?: string;
        readonly reason: string;
      };
    }
  | { readonly ok: false; readonly errors: Errors };

/**
 * Placing a hold: on a person (every record about them) chosen by name, or on one record by its
 * type and id; with a reason of 10 to 500 characters.
 */
export function readPlaceHold(form: FormLike, t: Translator): PlaceHoldRead {
  const errors: Record<string, string> = {};
  const target = text(form, "target") === "record" ? "record" : "person";
  const reason = text(form, "reason");
  const reasonProblem = reasonError(reason, t, "place");
  if (reasonProblem) errors.reason = reasonProblem;
  if (target === "person") {
    const personId = text(form, "personId");
    if (!UUID.test(personId)) errors.personId = t("retention.hold.personRequired");
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, body: { personId, reason } };
  }
  const subjectType = text(form, "subjectType");
  const subjectId = text(form, "subjectId").toLowerCase();
  if (
    !SUBJECT_TYPE.test(subjectType) ||
    !(HOLD_RECORD_TYPES as readonly string[]).includes(subjectType)
  )
    errors.subjectType = t("retention.hold.typeRequired");
  if (!UUID.test(subjectId)) errors.subjectId = t("retention.hold.idRequired");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { subjectType, subjectId, reason } };
}

/** Releasing a hold: a reason of 10 to 500 characters. */
export function readRelease(
  form: FormLike,
  t: Translator,
): { ok: true; reason: string } | { ok: false; errors: Errors } {
  const reason = text(form, "reason");
  const problem = reasonError(reason, t, "release");
  return problem ? { ok: false, errors: { reason: problem } } : { ok: true, reason };
}

export type DestroyRead =
  | { readonly ok: true; readonly documentIds: string[]; readonly reason: string }
  | { readonly ok: false; readonly errors: Errors };

/**
 * The destruction form: at least one document ticked (only ids the page offered), a reason of 10
 * to 500 characters, and the box that says the files cannot be recovered. Nothing is sent without
 * all three.
 */
export function readDestroy(
  form:
    | FormData
    | { getAll(name: string): FormDataEntryValue[]; get(name: string): FormDataEntryValue | null },
  t: Translator,
  offered: ReadonlySet<string>,
): DestroyRead {
  const errors: Record<string, string> = {};
  const documentIds = [
    ...new Set(
      form.getAll("documentId").filter((v): v is string => typeof v === "string" && offered.has(v)),
    ),
  ];
  if (documentIds.length === 0) errors.documentId = t("retention.destroy.noneChosen");
  if (documentIds.length > DESTROY_MAX) {
    errors.documentId = t("retention.destroy.tooMany", { max: DESTROY_MAX });
  }
  const reason = text(form, "reason");
  const problem = reasonError(reason, t, "destroy");
  if (problem) errors.reason = problem;
  if (text(form, "irreversible") !== "yes")
    errors.irreversible = t("retention.destroy.confirmError");
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, documentIds, reason };
}

/** What destruction did, in words: how many destroyed, how many skipped, certificates issued. */
export function destroyOutcome(result: {
  readonly certificates: readonly { readonly recordCount: number }[];
  readonly skipped: readonly string[];
}): { destroyed: number; skipped: number; certificates: number } {
  return {
    destroyed: result.certificates.reduce((sum, c) => sum + c.recordCount, 0),
    skipped: result.skipped.length,
    certificates: result.certificates.length,
  };
}

/** "storage_delete_all_versions:s3" as words: every stored version deleted, and where. */
export function methodWords(method: string, t: Translator): string {
  const [how, where] = method.split(":");
  if (how === "storage_delete_all_versions") {
    return t("retention.certificate.method.deleteAll", { where: where ?? "" });
  }
  if (how === "kms_key_destroy") {
    return t("retention.certificate.method.keyDestroy", { where: where ?? "" });
  }
  return method;
}
