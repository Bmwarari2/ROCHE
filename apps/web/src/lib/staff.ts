import type { paths } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import type { FieldProblem } from "./outcome";
import { type FormLike, readDateField, ukToday } from "./uk-time";

/**
 * The staff file, compliance, sponsor and privacy screens (workforce.md sections 2a, 5 and 12;
 * WORK-002, WORK-003, WORK-011; plan slice 56). What each person is offered follows their
 * permissions; the API and the database check every one again. Sponsor records are HR only
 * (`workforce.immigration.read`) and never one's own: the list and the record page leave out the
 * reader's own record, as the API does.
 */

type Ok<P extends keyof paths, M extends "get" | "post" | "put" | "patch"> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer B } } };
}
  ? B
  : never;

export type StaffFileItem = Ok<"/v1/workforce/staff-files/{id}", "get">;
export type StaffFileSummary = Ok<"/v1/workforce/staff-files", "get">["items"][number];
export type SponsoredWorker = Ok<"/v1/workforce/sponsored-workers", "get">["items"][number];
export type StaffPrivacy = Ok<"/v1/me/staff-privacy", "get">;
export type StaffName = NonNullable<Ok<"/v1/workforce/staff-members", "get">["items"][number]>;
export type ComplianceItemView = StaffFileItem["items"][number];
export type ComplianceKind = ComplianceItemView["kind"];
/** What the record form sends (the API's request schema). */
export type ComplianceDetail = NonNullable<
  NonNullable<
    paths["/v1/workforce/staff-files/{id}/items/{kind}"]["put"]["requestBody"]
  >["content"]["application/json"]["detail"]
>;
/** What a kept item says (the response, for filling the form). */
export type KeptDetail = ComplianceItemView["detail"];

export const STAFF_PAGE = "/staff";
export const SPONSOR_PAGE = "/staff/sponsorship";
export const PRIVACY_PAGE = "/settings/privacy";

export const STAFF_READ = "workforce.staff_file.read";
export const STAFF_MANAGE = "workforce.staff_file.manage";
export const DBS_SIGN = "workforce.dbs_risk_assessment.sign";
export const IMMIGRATION_READ = "workforce.immigration.read";
export const SPONSOR_MANAGE = "workforce.sponsor.manage";
export const SELF_READ = "workforce.self.read";
export const TENANT_MANAGE = "platform.tenant.manage";

const has = (permissions: readonly string[], p: string) => permissions.includes(p);

export function staffFilesShown(permissions: readonly string[]): boolean {
  return has(permissions, STAFF_READ) || has(permissions, STAFF_MANAGE);
}
export function staffFilesManaged(permissions: readonly string[]): boolean {
  return has(permissions, STAFF_MANAGE);
}
export function sponsorShown(permissions: readonly string[]): boolean {
  return has(permissions, IMMIGRATION_READ);
}
export function sponsorManaged(permissions: readonly string[]): boolean {
  return has(permissions, IMMIGRATION_READ) && has(permissions, SPONSOR_MANAGE);
}
export function privacyShown(permissions: readonly string[]): boolean {
  return has(permissions, SELF_READ);
}
export function noticeManaged(permissions: readonly string[]): boolean {
  return has(permissions, TENANT_MANAGE);
}

/** A status as an icon and a word (never colour alone). */
export type StaffChipIcon = "circle-check" | "clock" | "circle-alert" | "circle-minus" | "ban";
export interface StaffChip {
  readonly status: StatusChipStatus;
  readonly icon: StaffChipIcon;
  readonly label: string;
}

const COMPLIANCE_CHIP: Record<
  ComplianceItemView["status"],
  { status: StatusChipStatus; icon: StaffChipIcon }
> = {
  satisfied: { status: "done", icon: "circle-check" },
  due_soon: { status: "due", icon: "clock" },
  expired: { status: "overdue", icon: "circle-alert" },
  missing: { status: "notRecorded", icon: "circle-alert" },
  not_required: { status: "notApplicable", icon: "circle-minus" },
};

export function complianceChip(status: ComplianceItemView["status"], t: Translator): StaffChip {
  const look = COMPLIANCE_CHIP[status];
  return { status: look.status, icon: look.icon, label: t("staff.item.status", { status }) };
}

export function fileChip(complete: boolean, t: Translator): StaffChip {
  return complete
    ? { status: "done", icon: "circle-check", label: t("staff.file.complete") }
    : { status: "notRecorded", icon: "circle-alert", label: t("staff.file.incomplete") };
}

export function visaChip(visa: SponsoredWorker["visa"], t: Translator): StaffChip {
  const look: Record<SponsoredWorker["visa"], { status: StatusChipStatus; icon: StaffChipIcon }> = {
    valid: { status: "done", icon: "circle-check" },
    due_soon: { status: "due", icon: "clock" },
    expired: { status: "overdue", icon: "circle-alert" },
  };
  return { ...look[visa], label: t("sponsor.visa.state", { state: visa }) };
}

export function salaryChip(passes: boolean, t: Translator): StaffChip {
  return passes
    ? { status: "done", icon: "circle-check", label: t("sponsor.salary.passes") }
    : { status: "overdue", icon: "circle-alert", label: t("sponsor.salary.fails") };
}

export function reportChip(
  state: SponsoredWorker["reports"][number]["state"],
  t: Translator,
): StaffChip {
  const look: Record<typeof state, { status: StatusChipStatus; icon: StaffChipIcon }> = {
    reported: { status: "done", icon: "circle-check" },
    reported_late: { status: "notRecorded", icon: "circle-alert" },
    open: { status: "due", icon: "clock" },
    overdue: { status: "overdue", icon: "circle-alert" },
  };
  return { ...look[state], label: t("sponsor.report.state", { state }) };
}

export function consentChip(
  decision: StaffPrivacy["imageConsent"][number]["decision"],
  t: Translator,
): StaffChip {
  return decision === "given"
    ? { status: "done", icon: "circle-check", label: t("privacy.image.decision", { decision }) }
    : decision === "none"
      ? {
          status: "notRecorded",
          icon: "circle-minus",
          label: t("privacy.image.decision", { decision }),
        }
      : { status: "notApplicable", icon: "ban", label: t("privacy.image.decision", { decision }) };
}

/** Members a new staff file or sponsor record may be for: never oneself, never one already kept. */
export function choosableMembers(
  members: readonly (StaffName | null)[],
  self: string,
  taken: readonly string[],
): StaffName[] {
  return members.filter(
    (m): m is StaffName => m !== null && m.id !== self && !taken.includes(m.id),
  );
}

/** The reader's own sponsor record is never shown to them (the API leaves it out too). */
export function othersOnly<T extends { readonly tenantUserId: string }>(
  rows: readonly T[],
  self: string,
): T[] {
  return rows.filter((r) => r.tenantUserId !== self);
}

type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: FieldProblem[] };

const text = (form: FormLike, name: string) => String(form.get(name) ?? "").trim();
const ticked = (form: FormLike, name: string) => form.get(name) === "on";

function done<T>(problems: FieldProblem[], value: () => T): Read<T> {
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: value() };
}

function date(
  form: FormLike,
  name: string,
  subject: string,
  problems: FieldProblem[],
  t: Translator,
  optional = false,
): string | null {
  const read = readDateField(form, name, { subject, optional, t });
  if (read.ok) return read.date;
  problems.push({ field: name, message: read.message, parts: read.parts });
  return null;
}

function whole(
  form: FormLike,
  name: string,
  max: number,
  message: string,
  problems: FieldProblem[],
): number {
  const raw = text(form, name);
  const n = Number(raw);
  if (raw === "" || !Number.isInteger(n) || n < 0 || n > max) {
    problems.push({ field: name, message });
    return 0;
  }
  return n;
}

export const REGISTRATION_BODIES = ["nmc", "hcpc", "swe", "gmc"] as const;

export interface StaffFileInput {
  readonly tenantUserId?: string;
  readonly locationId: string | null;
  readonly jobTitle: string;
  readonly pathwayCategory: string | null;
  readonly registrationBody: (typeof REGISTRATION_BODIES)[number] | null;
  readonly previousCareWork: boolean;
  readonly dateOfBirth: string | null;
  readonly startsOn: string | null;
  readonly leftOn: string | null;
}

/** The profile form: a new file (with the member) or a change to one. */
export function readStaffFile(
  form: FormLike,
  t: Translator,
  withMember: boolean,
): Read<StaffFileInput> {
  const problems: FieldProblem[] = [];
  const member = text(form, "tenantUserId");
  if (withMember && !member)
    problems.push({ field: "tenantUserId", message: t("staff.form.memberRequired") });
  const jobTitle = text(form, "jobTitle");
  if (jobTitle.length < 2 || jobTitle.length > 120)
    problems.push({ field: "jobTitle", message: t("staff.form.jobTitleRequired") });
  const pathway = text(form, "pathwayCategory");
  if (pathway && (pathway.length < 2 || pathway.length > 80))
    problems.push({ field: "pathwayCategory", message: t("staff.form.pathwayLength") });
  const body = text(form, "registrationBody");
  const startsOn = date(form, "startsOn", t("staff.form.startsOn"), problems, t, true);
  const leftOn = date(form, "leftOn", t("staff.form.leftOn"), problems, t, true);
  const dateOfBirth = date(form, "dateOfBirth", t("staff.form.dateOfBirth"), problems, t, true);
  if (startsOn && leftOn && leftOn < startsOn)
    problems.push({ field: "leftOn", message: t("staff.form.leftBeforeStart") });
  const location = text(form, "locationId");
  return done(problems, () => ({
    ...(withMember ? { tenantUserId: member } : {}),
    locationId: location || null,
    jobTitle,
    pathwayCategory: pathway || null,
    registrationBody: (REGISTRATION_BODIES as readonly string[]).includes(body)
      ? (body as StaffFileInput["registrationBody"])
      : null,
    previousCareWork: ticked(form, "previousCareWork"),
    dateOfBirth,
    startsOn,
    leftOn,
  }));
}

/** The kinds the record form takes; the employment history is recorded through the API for now. */
export const RECORDABLE_KINDS: readonly ComplianceKind[] = [
  "identity_with_photo",
  "dbs_certificate",
  "conduct_in_care_work",
  "references",
  "relevant_qualifications",
  "health_fitness",
  "right_to_work",
  "professional_registration",
];

export const IDENTITY_DOCUMENTS = [
  "passport",
  "photocard_driving_licence",
  "national_identity_card",
  "biometric_residence_permit",
  "other_photo_document",
] as const;
export const DBS_LEVELS = ["enhanced_adults_barred", "enhanced", "standard", "basic"] as const;
export const RTW_METHODS = ["manual_document", "online_share_code", "idsp"] as const;

const oneOf = <T extends string>(
  values: readonly T[],
  value: string,
  field: string,
  message: string,
  problems: FieldProblem[],
): T => {
  if ((values as readonly string[]).includes(value)) return value as T;
  problems.push({ field, message });
  return values[0] as T;
};

export interface ComplianceInput {
  readonly detail: ComplianceDetail;
  readonly verifiedOn: string | null;
}

/**
 * One Schedule 3 item's form, by kind. A right to work check is added to the checks already
 * kept; qualifications are one a line. "Verified today" verifies it in the reader's name.
 */
export function readComplianceItem(
  form: FormLike,
  kind: ComplianceKind,
  existing: KeptDetail,
  t: Translator,
  today: string = ukToday(),
): Read<ComplianceInput> {
  const problems: FieldProblem[] = [];
  let detail: ComplianceDetail | null = null;
  switch (kind) {
    case "identity_with_photo":
      detail = {
        kind,
        document: oneOf(
          IDENTITY_DOCUMENTS,
          text(form, "document"),
          "document",
          t("staff.choose.document"),
          problems,
        ),
      };
      break;
    case "dbs_certificate": {
      const level = oneOf(
        DBS_LEVELS,
        text(form, "level"),
        "level",
        t("staff.choose.level"),
        problems,
      );
      const issuedOn = date(form, "issuedOn", t("staff.dbs.issuedOn"), problems, t);
      const number = text(form, "number").replace(/\s+/g, "");
      if (!/^\d{12}$/.test(number))
        problems.push({ field: "number", message: t("staff.dbs.numberFormat") });
      const result = oneOf(
        ["clear", "information_disclosed"] as const,
        text(form, "result"),
        "result",
        t("staff.choose.result"),
        problems,
      );
      const barred = date(form, "barredListClearOn", t("staff.dbs.barredOn"), problems, t, true);
      detail = {
        kind,
        certificate: { level, issuedOn: issuedOn ?? today, number, result },
        updateService: ticked(form, "updateService")
          ? { subscribed: true, lastCheckedOn: null, lastResult: null }
          : null,
        barredListClearOn: barred,
      };
      break;
    }
    case "conduct_in_care_work":
      detail = {
        kind,
        employersContacted: whole(
          form,
          "count",
          50,
          t("staff.form.countRange", { max: 50 }),
          problems,
        ),
      };
      break;
    case "references":
      detail = {
        kind,
        received: whole(form, "count", 20, t("staff.form.countRange", { max: 20 }), problems),
      };
      break;
    case "relevant_qualifications": {
      const qualifications = text(form, "qualifications")
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean);
      if (qualifications.length > 30 || qualifications.some((q) => q.length < 2 || q.length > 160))
        problems.push({ field: "qualifications", message: t("staff.form.qualificationsFormat") });
      detail = { kind, qualifications };
      break;
    }
    case "health_fitness":
      detail = {
        kind,
        declaredFit: ticked(form, "declaredFit"),
        adjustmentsAgreed: ticked(form, "adjustmentsAgreed"),
      };
      break;
    case "right_to_work": {
      const checkedOn = date(form, "checkedOn", t("staff.rtw.checkedOn"), problems, t);
      const method = oneOf(
        RTW_METHODS,
        text(form, "method"),
        "method",
        t("staff.choose.method"),
        problems,
      );
      const permission = oneOf(
        ["unlimited", "time_limited"] as const,
        text(form, "permission"),
        "permission",
        t("staff.choose.permission"),
        problems,
      );
      const expiresOn = date(form, "expiresOn", t("staff.rtw.expiresOn"), problems, t, true);
      if (
        permission === "time_limited" &&
        !expiresOn &&
        !problems.some((p) => p.field === "expiresOn")
      )
        problems.push({ field: "expiresOn", message: t("staff.rtw.expiryRequired") });
      const earlier = existing?.kind === "right_to_work" ? existing.checks : [];
      detail = {
        kind,
        checks: [
          ...earlier,
          {
            checkedOn: checkedOn ?? today,
            method,
            permission,
            expiresOn: permission === "unlimited" ? null : expiresOn,
          },
        ],
      };
      break;
    }
    case "professional_registration": {
      const body = oneOf(
        REGISTRATION_BODIES,
        text(form, "body"),
        "body",
        t("staff.choose.body"),
        problems,
      );
      const pin = text(form, "pin").toUpperCase();
      if (!/^[0-9A-Z]{4,12}$/.test(pin))
        problems.push({ field: "pin", message: t("staff.registration.pinFormat") });
      const renewalDueOn = date(form, "renewalDueOn", t("staff.registration.renewal"), problems, t);
      const revalidationDueOn = date(
        form,
        "revalidationDueOn",
        t("staff.registration.revalidation"),
        problems,
        t,
        true,
      );
      detail = { kind, body, pin, renewalDueOn: renewalDueOn ?? today, revalidationDueOn };
      break;
    }
    default:
      // The employment history has no form here (RECORDABLE_KINDS); the page offers none.
      return {
        ok: false,
        problems: [{ field: "document", message: t("staff.form.notRecordable") }],
      };
  }
  return done(problems, () => ({
    detail: detail as ComplianceDetail,
    verifiedOn: ticked(form, "verifiedToday") ? today : null,
  }));
}

export const SPONSOR_ROUTES = ["skilled_worker", "health_and_care_worker", "other"] as const;
export const ENGLISH_EVIDENCE = [
  "not_recorded",
  "majority_english_speaking_country",
  "degree_taught_in_english",
  "secure_english_language_test",
  "previous_grant",
] as const;
export const APPENDIX_D = [
  "passport_or_travel_document",
  "right_to_work_check",
  "contact_details",
  "certificate_of_sponsorship",
  "recruitment_evidence",
  "english_language_evidence",
  "registration_or_qualification",
  "absence_records",
] as const;
export const REPORT_KINDS = [
  "did_not_start",
  "unauthorised_absence",
  "employment_ended",
  "change_of_job",
  "change_of_salary",
  "change_of_work_location",
  "change_of_hours",
  "other",
] as const;

export interface SponsorInput {
  readonly tenantUserId?: string;
  readonly cosReference: string;
  readonly cosAssignedOn: string;
  readonly socCode: string;
  readonly route: (typeof SPONSOR_ROUTES)[number];
  readonly visaExpiresOn: string;
  readonly contractedWeeklyHours: number;
  readonly guaranteedYearlyPay: number;
  readonly englishEvidence: (typeof ENGLISH_EVIDENCE)[number];
  readonly switchingEvidenceOn: string | null;
  readonly appendixDHeld: (typeof APPENDIX_D)[number][];
  readonly endedOn?: string | null;
}

function decimal(
  form: FormLike,
  name: string,
  min: number,
  max: number,
  message: string,
  problems: FieldProblem[],
): number {
  const raw = text(form, name).replace(/[£,\s]/g, "");
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n) || n < min || n > max || !/^\d+(\.\d{1,2})?$/.test(raw)) {
    problems.push({ field: name, message });
    return 0;
  }
  return n;
}

/** The sponsored worker form: a new record (with the member) or a change (with an end date). */
export function readSponsoredWorker(
  form: FormLike,
  t: Translator,
  withMember: boolean,
): Read<SponsorInput> {
  const problems: FieldProblem[] = [];
  const member = text(form, "tenantUserId");
  if (withMember && !member)
    problems.push({ field: "tenantUserId", message: t("staff.form.memberRequired") });
  const cos = text(form, "cosReference").toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]{6,20}$/.test(cos))
    problems.push({ field: "cosReference", message: t("sponsor.form.cosFormat") });
  const cosAssignedOn = date(form, "cosAssignedOn", t("sponsor.form.cosAssignedOn"), problems, t);
  const soc = text(form, "socCode");
  if (!/^\d{4}$/.test(soc))
    problems.push({ field: "socCode", message: t("sponsor.form.socFormat") });
  const route = oneOf(
    SPONSOR_ROUTES,
    text(form, "route"),
    "route",
    t("sponsor.choose.route"),
    problems,
  );
  const visaExpiresOn = date(form, "visaExpiresOn", t("sponsor.form.visaExpiresOn"), problems, t);
  const hours = decimal(
    form,
    "contractedWeeklyHours",
    0.01,
    168,
    t("sponsor.form.hoursFormat"),
    problems,
  );
  const pay = decimal(
    form,
    "guaranteedYearlyPay",
    0,
    10_000_000,
    t("sponsor.form.payFormat"),
    problems,
  );
  const englishEvidence = oneOf(
    ENGLISH_EVIDENCE,
    text(form, "englishEvidence") || "not_recorded",
    "englishEvidence",
    t("sponsor.choose.english"),
    problems,
  );
  const switchingEvidenceOn = date(
    form,
    "switchingEvidenceOn",
    t("sponsor.form.switching"),
    problems,
    t,
    true,
  );
  const endedOn = withMember
    ? null
    : date(form, "endedOn", t("sponsor.form.endedOn"), problems, t, true);
  const held = APPENDIX_D.filter((item) => ticked(form, `appendixD.${item}`));
  return done(problems, () => ({
    ...(withMember ? { tenantUserId: member } : { endedOn }),
    cosReference: cos,
    cosAssignedOn: cosAssignedOn as string,
    socCode: soc,
    route,
    visaExpiresOn: visaExpiresOn as string,
    contractedWeeklyHours: hours,
    guaranteedYearlyPay: pay,
    englishEvidence,
    switchingEvidenceOn,
    appendixDHeld: held,
  }));
}

export function readAbsence(
  form: FormLike,
  t: Translator,
): Read<{ fromOn: string; toOn: string; authorised: boolean }> {
  const problems: FieldProblem[] = [];
  const fromOn = date(form, "fromOn", t("sponsor.absence.from"), problems, t);
  const toOn = date(form, "toOn", t("sponsor.absence.to"), problems, t);
  if (fromOn && toOn && toOn < fromOn)
    problems.push({ field: "toOn", message: t("sponsor.absence.order") });
  const authorised = text(form, "authorised");
  if (authorised !== "yes" && authorised !== "no")
    problems.push({ field: "authorised", message: t("sponsor.choose.authorised") });
  return done(problems, () => ({
    fromOn: fromOn as string,
    toOn: toOn as string,
    authorised: authorised === "yes",
  }));
}

export function readReport(
  form: FormLike,
  t: Translator,
  today: string = ukToday(),
): Read<{ kind: (typeof REPORT_KINDS)[number]; happenedOn: string }> {
  const problems: FieldProblem[] = [];
  const kind = oneOf(REPORT_KINDS, text(form, "kind"), "kind", t("sponsor.choose.kind"), problems);
  const happenedOn = date(form, "happenedOn", t("sponsor.report.happenedOn"), problems, t);
  if (happenedOn && happenedOn > today)
    problems.push({ field: "happenedOn", message: t("sponsor.report.notFuture") });
  return done(problems, () => ({ kind, happenedOn: happenedOn as string }));
}

export function readMarkReported(
  form: FormLike,
  happenedOn: string,
  t: Translator,
  today: string = ukToday(),
): Read<{ reportedOn: string; smsReference: string }> {
  const problems: FieldProblem[] = [];
  const reportedOn = date(form, "reportedOn", t("sponsor.report.reportedOn"), problems, t);
  if (reportedOn && (reportedOn > today || reportedOn < happenedOn))
    problems.push({ field: "reportedOn", message: t("sponsor.report.reportedRange") });
  const smsReference = text(form, "smsReference");
  if (smsReference.length < 1 || smsReference.length > 40)
    problems.push({ field: "smsReference", message: t("sponsor.report.referenceRequired") });
  return done(problems, () => ({ reportedOn: reportedOn as string, smsReference }));
}

export function readNoticeVersion(form: FormLike, t: Translator): Read<{ version: string }> {
  const version = text(form, "version");
  return version.length >= 1 && version.length <= 40
    ? { ok: true, value: { version } }
    : { ok: false, problems: [{ field: "version", message: t("privacy.notice.versionRequired") }] };
}

const ITEM_DONE = /^item-([a-z_]+)$/;
const CONSENT_DONE = /^consent-([a-z_]+)$/;

/** What a staff file page says after a save (`?done=`), or null for anything else. */
export function staffDone(done: string, t: Translator): string | null {
  if (done === "created") return t("staff.done.created");
  if (done === "saved") return t("staff.done.saved");
  const item = ITEM_DONE.exec(done)?.[1];
  if (item && (RECORDABLE_KINDS as readonly string[]).includes(item))
    return t("staff.form.itemSaved", { kind: item });
  return null;
}

/** What a sponsored worker's page says after a save. */
export function sponsorDone(done: string, t: Translator): string | null {
  switch (done) {
    case "created":
    case "saved":
    case "absence":
    case "report":
    case "reported":
      return t("sponsor.done", { done });
    default:
      return null;
  }
}

/** What My privacy says after a save. */
export function privacyDone(done: string, t: Translator): string | null {
  if (done === "acknowledged") return t("privacy.notice.acknowledged");
  const purpose = CONSENT_DONE.exec(done)?.[1];
  if (purpose && ["newsletter", "website", "social_media", "family_feed"].includes(purpose))
    return t("privacy.image.saved", { purpose });
  return null;
}
