import type { components } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import { CircleCheck, CircleSlash, type LucideIcon, TriangleAlert } from "lucide-react";
import { type FormWithAll, medicinesHref, type Read } from "./medicines";
import { readDateField } from "./uk-time";

/**
 * Homely remedies on the web (slice 55; MEDS-007; medicines.md section 15.3; HZ-120): pure helpers
 * for the home's protocols and a person's doses. A protocol is the home's own, agreed with a GP or
 * pharmacist; Harbour checks a dose against it and recommends nothing. The forms are read here so a
 * mistake is said at its field first; the API runs every rule again (the rate table's limits on the
 * days and the review, who may give it, the gap, the 24 hours, the course) and answers in words,
 * which are shown as they are. Harbour never matches a remedy to an allergy (HZ-007, ADR-0082).
 */

type Schemas = components["schemas"];
export type HomelyProtocol = Schemas["HomelyProtocol"];
export type HomelyDose = Schemas["HomelyDose"];
export type HomelyDoseCheck = Schemas["HomelyDoseCheck"];
export type ProtocolBody = Schemas["NewHomelyProtocol"];
export type ProtocolChangeBody = Schemas["ChangeHomelyProtocol"];
export type ProtocolWithdrawBody = Schemas["WithdrawHomelyProtocol"];
export type CheckBody = Schemas["CheckHomelyDose"];
export type DoseBody = Schemas["RecordHomelyDose"];
export type EnteredInErrorBody = Schemas["HomelyDoseEnteredInError"];

/** Who may read protocols and doses (the API's READERS for these routes). */
export const HOMELY_READERS = [
  "medicines.record.manage",
  "medicines.emar.administer",
  "care.plan.read",
] as const;
/** Who may add, change and withdraw a protocol, at the home. */
export const HOMELY_MANAGER = "medicines.record.manage";
/** Who may check and give a homely remedy (and must be named on the protocol). */
export const HOMELY_GIVER = "medicines.emar.administer";

export const homelyShown = (permissions: readonly string[]) =>
  HOMELY_READERS.some((p) => permissions.includes(p));
export const mayManageProtocols = (permissions: readonly string[]) =>
  permissions.includes(HOMELY_MANAGER);
export const mayGiveHomely = (permissions: readonly string[]) => permissions.includes(HOMELY_GIVER);

export const protocolsHref = (locationId: string) =>
  `/medicines-stock/${locationId}/homely-remedies`;
export const newProtocolHref = (locationId: string) => `${protocolsHref(locationId)}/new`;
export const changeProtocolHref = (locationId: string, protocolId: string) =>
  `${protocolsHref(locationId)}/${protocolId}/change`;
export const withdrawProtocolHref = (locationId: string, protocolId: string) =>
  `${protocolsHref(locationId)}/${protocolId}/withdraw`;
export const personHomelyHref = (personId: string) => `${medicinesHref(personId)}/homely-remedies`;

/** A protocol's state as an icon and the API's words (never colour alone). */
export function protocolChip(protocol: Pick<HomelyProtocol, "status" | "statusWords">): {
  readonly status: StatusChipStatus;
  readonly icon: LucideIcon;
  readonly label: string;
} {
  switch (protocol.status) {
    case "in_use":
      return { status: "done", icon: CircleCheck, label: protocol.statusWords };
    case "review_overdue":
      return { status: "overdue", icon: TriangleAlert, label: protocol.statusWords };
    case "withdrawn":
      return { status: "notApplicable", icon: CircleSlash, label: protocol.statusWords };
  }
}

/** Protocols a dose may be checked against: in use only (the API refuses the others in words). */
export function usableProtocols(protocols: readonly HomelyProtocol[]): HomelyProtocol[] {
  return protocols.filter((p) => p.status === "in_use");
}

/**
 * The doses as the page lists them, newest first as the API gives them: each dose given, with the
 * record that marked it entered in error (its reason), if any. The marking records themselves are
 * not listed on their own.
 */
export function doseRows(
  items: readonly HomelyDose[],
): { readonly dose: HomelyDose; readonly correction: HomelyDose | null }[] {
  const byId = new Map(items.map((d) => [d.id, d]));
  return items
    .filter((d) => d.outcome === "given")
    .map((dose) => ({
      dose,
      correction: dose.enteredInErrorBy ? (byId.get(dose.enteredInErrorBy) ?? null) : null,
    }));
}

/**
 * Whether the reader may mark a dose entered in error: a dose still standing, by the member who
 * gave it (who may give homely remedies) or by a medicines manager. The API checks the home again.
 */
export function mayMarkInError(
  dose: Pick<HomelyDose, "outcome" | "enteredInErrorBy" | "givenBy">,
  me: { readonly tenantUserId: string; readonly permissions: readonly string[] },
): boolean {
  if (dose.outcome !== "given" || dose.enteredInErrorBy !== null) return false;
  if (me.permissions.includes(HOMELY_MANAGER)) return true;
  return me.permissions.includes(HOMELY_GIVER) && dose.givenBy === me.tenantUserId;
}

/** What the API's check said: within the protocol now, or each problem in the API's words. */
export function checkSays(
  check: HomelyDoseCheck,
): { readonly within: true } | { readonly within: false; readonly messages: string[] } {
  return check.problems.length === 0
    ? { within: true }
    : { within: false, messages: check.problems.map((p) => p.message) };
}

/** The key a check was made for, so a changed protocol or amount needs a new check. */
export const checkKey = (protocolId: string, quantity: string) =>
  `${protocolId}|${quantity.trim()}`;

/** Someone the protocol may name, with the words shown beside their box. */
export interface MemberOption {
  readonly id: string;
  readonly label: string;
}

/**
 * The staff a protocol may name: the organisation's staff the reader may list (by display name and
 * job title), the reader themselves, and anyone the protocol already names who is not listed (so a
 * change never drops them unseen), sorted by name with the unknown last.
 */
export function memberOptions(
  listed: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly jobTitle?: string | null;
  }[],
  me: { readonly tenantUserId: string; readonly name: string },
  named: readonly string[],
  t: Translator,
): MemberOption[] {
  const seen = new Map<string, MemberOption>();
  for (const m of listed) {
    if (seen.has(m.id)) continue;
    seen.set(m.id, {
      id: m.id,
      label: m.jobTitle
        ? t("medicines.homely.member.withJob", { name: m.displayName, job: m.jobTitle })
        : m.displayName,
    });
  }
  if (!seen.has(me.tenantUserId)) {
    seen.set(me.tenantUserId, {
      id: me.tenantUserId,
      label: t("medicines.homely.member.you", { name: me.name }),
    });
  }
  const known = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, "en-GB"));
  const unknown = named
    .filter((id, i) => !seen.has(id) && named.indexOf(id) === i)
    .map((id) => ({ id, label: t("medicines.homely.member.unlisted") }));
  return [...known, ...unknown];
}

const text = (form: FormWithAll, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** A positive amount as typed: no leading zero, at most three decimal places, never rounded. */
const QUANTITY = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/;
const HOURS = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/;
const WHOLE = /^[1-9]\d{0,2}$/;
const VMP = /^[0-9]{6,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An amount above zero and at most 100,000, as the contract allows; null otherwise. */
export function readAmount(raw: string): number | null {
  if (!QUANTITY.test(raw)) return null;
  const value = Number(raw);
  return value > 0 && value <= 100_000 ? value : null;
}

function words(
  form: FormWithAll,
  name: string,
  max: number,
  errors: Record<string, string>,
  message: string,
): string {
  const value = text(form, name);
  if (!value || value.length > max) errors[name] = message;
  return value;
}

/**
 * Reads the protocol form into `NewHomelyProtocol`: the product (and its dm+d code when known),
 * what it is for, one dose and its unit, the shortest gap in hours, the most in 24 hours, the days
 * before the GP is asked, the staff allowed to give it, and who agreed it, when, and the review.
 * The rate table's limits on the days and the review are the API's to apply (never a literal).
 */
export function readProtocol(form: FormWithAll, t: Translator): Read<ProtocolBody> {
  const errors: Record<string, string> = {};
  const productName = words(
    form,
    "productName",
    200,
    errors,
    t("medicines.homely.form.productError"),
  );
  const vmpText = text(form, "vmpId");
  if (vmpText && !VMP.test(vmpText)) errors.vmpId = t("medicines.homely.form.vmpError");
  const indication = words(
    form,
    "indication",
    500,
    errors,
    t("medicines.homely.form.indicationError"),
  );
  const doseQuantity = readAmount(text(form, "doseQuantity"));
  if (doseQuantity === null) errors.doseQuantity = t("medicines.homely.form.doseError");
  const unitName = words(form, "unitName", 60, errors, t("medicines.homely.form.unitError"));
  const hoursText = text(form, "minIntervalHours");
  const minIntervalHours = HOURS.test(hoursText) ? Number(hoursText) : Number.NaN;
  if (!(minIntervalHours > 0 && minIntervalHours <= 168)) {
    errors.minIntervalHours = t("medicines.homely.form.intervalError");
  }
  const maxDailyQuantity = readAmount(text(form, "maxDailyQuantity"));
  if (maxDailyQuantity === null) errors.maxDailyQuantity = t("medicines.homely.form.dailyError");
  else if (doseQuantity !== null && maxDailyQuantity < doseQuantity) {
    errors.maxDailyQuantity = t("medicines.homely.form.dailyBelowDose");
  }
  const daysText = text(form, "maxDays");
  const maxDays = WHOLE.test(daysText) ? Number(daysText) : Number.NaN;
  if (!(maxDays >= 1 && maxDays <= 365)) errors.maxDays = t("medicines.homely.form.daysError");
  const authorisedMemberIds = [
    ...new Set(
      form
        .getAll("authorisedMemberIds")
        .filter((v): v is string => typeof v === "string" && UUID.test(v)),
    ),
  ];
  if (authorisedMemberIds.length === 0) {
    errors.authorisedMemberIds = t("medicines.homely.form.staffError");
  }
  const approvedByName = words(
    form,
    "approvedByName",
    200,
    errors,
    t("medicines.homely.form.approvedByError"),
  );
  const role = text(form, "approvedByRole");
  if (role !== "gp" && role !== "pharmacist") {
    errors.approvedByRole = t("medicines.homely.form.roleError");
  }
  const approved = readDateField(form, "approvedOn", {
    t,
    subject: t("medicines.homely.form.approvedOnSubject"),
  });
  if (!approved.ok) errors.approvedOn = approved.message;
  const review = readDateField(form, "reviewOn", {
    t,
    subject: t("medicines.homely.form.reviewOnSubject"),
  });
  if (!review.ok) errors.reviewOn = review.message;
  else if (approved.ok && approved.date && review.date && review.date <= approved.date) {
    errors.reviewOn = t("medicines.homely.form.reviewAfterError");
  }
  if (
    Object.keys(errors).length > 0 ||
    doseQuantity === null ||
    maxDailyQuantity === null ||
    !approved.ok ||
    !approved.date ||
    !review.ok ||
    !review.date
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    body: {
      productName,
      vmpId: vmpText || null,
      indication,
      doseQuantity,
      unitName,
      minIntervalHours,
      maxDailyQuantity,
      maxDays,
      authorisedMemberIds,
      approvedByName,
      approvedByRole: role as "gp" | "pharmacist",
      approvedOn: approved.date,
      reviewOn: review.date,
    },
  };
}

/** Reads a change to a protocol: every field again, a new reason, and the version read. */
export function readProtocolChange(
  form: FormWithAll,
  t: Translator,
  version: number,
): Read<ProtocolChangeBody> {
  const read = readProtocol(form, t);
  const errors: Record<string, string> = read.ok ? {} : { ...read.errors };
  const reason = words(form, "reason", 500, errors, t("medicines.homely.form.changeReasonError"));
  if (!read.ok || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { ...read.body, reason, version } };
}

/** Reads the withdrawal: the reason and the version read. */
export function readWithdraw(
  form: FormWithAll,
  t: Translator,
  version: number,
): Read<ProtocolWithdrawBody> {
  const errors: Record<string, string> = {};
  const reason = words(form, "reason", 500, errors, t("medicines.homely.withdraw.reasonError"));
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { reason, version } };
}

/** Reads the protocol and the amount to check, before anything is given. */
export function readDoseCheck(form: FormWithAll, t: Translator): Read<CheckBody> {
  const errors: Record<string, string> = {};
  const protocolId = text(form, "protocolId");
  if (!UUID.test(protocolId)) errors.protocolId = t("medicines.homely.dose.protocolError");
  const quantity = readAmount(text(form, "quantity"));
  if (quantity === null) errors.quantity = t("medicines.homely.dose.quantityError");
  if (Object.keys(errors).length > 0 || quantity === null) return { ok: false, errors };
  return { ok: true, body: { protocolId, quantity } };
}

/**
 * Reads the record-a-dose form into `RecordHomelyDose`: the protocol and amount checked, why it is
 * given (the symptom), and the giver's confirmation that they compared the person's allergies with
 * the remedy (HZ-007). Recorded now, by the person signed in; a dose already given is not recorded
 * from this form.
 */
export function readDose(
  form: FormWithAll,
  t: Translator,
  context: { readonly id: string },
): Read<DoseBody> {
  const check = readDoseCheck(form, t);
  const errors: Record<string, string> = check.ok ? {} : { ...check.errors };
  const reason = words(form, "reason", 500, errors, t("medicines.homely.dose.reasonError"));
  if (text(form, "allergiesChecked") !== "yes") {
    errors.allergiesChecked = t("medicines.homely.dose.allergiesError");
  }
  // The person compares the remedy with every current medicine: the API matches only the same
  // dm+d product, never an ingredient (ADR-0082; clinical review of slice 55, HZ-120).
  if (text(form, "medicinesChecked") !== "yes") {
    errors.medicinesChecked = t("medicines.homely.dose.medicinesError");
  }
  if (!check.ok || Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      id: context.id,
      protocolId: check.body.protocolId,
      quantity: check.body.quantity,
      reason,
      allergiesChecked: true,
      alreadyGiven: null,
    },
  };
}

/** Reads marking a dose entered in error: the reason, with the client's id for the new record. */
export function readEnteredInError(
  form: FormWithAll,
  t: Translator,
  context: { readonly id: string },
): Read<EnteredInErrorBody> {
  const errors: Record<string, string> = {};
  const reason = words(form, "reason", 500, errors, t("medicines.homely.error.reasonError"));
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { id: context.id, reason } };
}

/**
 * Which protocol field each refusal belongs to (the API's code is `homely_` and the domain's
 * problem), so the API's words show there; anything else shows above the form.
 */
export const PROTOCOL_FIELD_FOR_PROBLEM: Readonly<Record<string, string>> = {
  homely_dose_not_positive: "doseQuantity",
  homely_daily_below_dose: "maxDailyQuantity",
  homely_interval_not_positive: "minIntervalHours",
  homely_max_days_out_of_range: "maxDays",
  homely_no_authorised_staff: "authorisedMemberIds",
  homely_unknown_member: "authorisedMemberIds",
  homely_approved_in_future: "approvedOn",
  homely_review_not_after_approval: "reviewOn",
  homely_review_too_far: "reviewOn",
};

/** Which dose field a refusal belongs to; the others (the gap, the 24 hours) show above the form. */
export const DOSE_FIELD_FOR_PROBLEM: Readonly<Record<string, string>> = {
  homely_dose_differs: "quantity",
  homely_other_home: "protocolId",
};

/**
 * A protocol's figures as the form's starting values, as the API holds them (a change starts from
 * what is there, never from a default).
 */
export function protocolDefaults(p: HomelyProtocol): Record<string, string> {
  return {
    productName: p.productName,
    vmpId: p.vmpId ?? "",
    indication: p.indication,
    doseQuantity: String(p.doseQuantity),
    unitName: p.unitName,
    minIntervalHours: String(p.minIntervalHours),
    maxDailyQuantity: String(p.maxDailyQuantity),
    maxDays: String(p.maxDays),
    approvedByName: p.approvedByName,
    approvedByRole: p.approvedByRole,
    approvedOn: p.approvedOn,
    reviewOn: p.reviewOn,
  };
}

/**
 * The medicines on the person's eMAR now, to compare with a homely remedy (HZ-120): stopped,
 * replaced and withdrawn entries are left out. The API checks only the same dm+d product; the
 * person giving the remedy compares the ingredients with these.
 */
export function currentMedicines(
  entries: readonly { state: string; product: { name: string }; directionsInWords: string }[],
): { product: string; directions: string }[] {
  return entries
    .filter((e) => !["stopped", "replaced", "withdrawn"].includes(e.state))
    .map((e) => ({ product: e.product.name, directions: e.directionsInWords }));
}
