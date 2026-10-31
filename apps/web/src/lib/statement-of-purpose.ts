import type { StatementOfPurposeContent, StatementOfPurposeVersionItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { QualityChip } from "./evidence-packs";
import type { FormValues } from "./incident-forms";
import type { FieldErrors } from "./outcome";
import { readDateTimeField } from "./uk-time";

/**
 * View logic for the statement of purpose screens (docs/specs/quality.md section 16; QUAL-009;
 * hazard HZ-080). Pure and unit tested. The API checks Schedule 3, approval and the CQC clock; these
 * functions read the editor and say the API's decisions in words.
 */

export const WRITE = "quality.statement_of_purpose.write";
export const APPROVE = "quality.statement_of_purpose.approve";
export const SUBMIT = "safety.notification.submit";

export function statementShown(permissions: readonly string[]): boolean {
  return [WRITE, APPROVE, SUBMIT].some((p) => permissions.includes(p));
}

/** The longest texts the API takes (packages/contracts/src/quality.ts). */
export const LIMITS = {
  long: 10_000,
  serviceKind: 200,
  serviceKinds: 20,
  name: 200,
  address: 500,
  phone: 40,
  email: 254,
  legalDetail: 200,
  cqcLocationId: 20,
  managers: 50,
  locations: 100,
  evidence: 500,
} as const;

export const LEGAL_STATUSES = [
  "individual",
  "partnership",
  "limited_company",
  "limited_liability_partnership",
  "charitable_incorporated_organisation",
  "community_interest_company",
  "nhs_body",
  "local_authority",
  "other",
] as const;
type LegalStatus = (typeof LEGAL_STATUSES)[number];

const isLegalStatus = (value: string): value is LegalStatus =>
  (LEGAL_STATUSES as readonly string[]).includes(value);

/** An empty statement, for the baseline editor. */
export const EMPTY_CONTENT: StatementOfPurposeContent = {
  aimsAndObjectives: "",
  serviceKinds: [],
  needsMet: "",
  provider: { fullName: "", businessAddress: "", businessPhone: "", email: null },
  registeredManagers: [],
  serviceAddress: "",
  consentsToEmailService: false,
  serviceEmail: null,
  legalStatus: null,
  legalStatusDetail: null,
  locations: [],
};

const text = (form: FormValues, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const texts = (form: FormValues, name: string) =>
  form.getAll(name).map((v) => (typeof v === "string" ? v.trim() : ""));

const orNull = (value: string) => (value.length > 0 ? value : null);

const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the editor into the API's content. Kinds of service are one per line. Each manager and
 * location row carries its id in a hidden field, so the change summary and the registration
 * prompts follow them; a row left wholly empty is dropped. Completeness against Schedule 3 is the
 * API's to say (a draft may be saved incomplete); only lengths the API would refuse are errors here.
 */
export function readStatementForm(
  form: FormValues,
  t: Translator,
):
  | { readonly ok: true; readonly content: StatementOfPurposeContent }
  | { readonly ok: false; readonly errors: FieldErrors } {
  const errors: Record<string, string> = {};
  const tooLong = (field: string, value: string, max: number) => {
    if (value.length > max) errors[field] ??= t("quality.sop.tooLong", { max });
  };

  const aimsAndObjectives = text(form, "aimsAndObjectives");
  tooLong("aimsAndObjectives", aimsAndObjectives, LIMITS.long);
  const serviceKinds = text(form, "serviceKinds")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (serviceKinds.length > LIMITS.serviceKinds) {
    errors.serviceKinds = t("quality.sop.tooMany", { max: LIMITS.serviceKinds });
  }
  for (const kind of serviceKinds) tooLong("serviceKinds", kind, LIMITS.serviceKind);
  const needsMet = text(form, "needsMet");
  tooLong("needsMet", needsMet, LIMITS.long);

  const provider = {
    fullName: text(form, "providerName"),
    businessAddress: text(form, "providerAddress"),
    businessPhone: text(form, "providerPhone"),
    email: orNull(text(form, "providerEmail")),
  };
  tooLong("providerName", provider.fullName, LIMITS.name);
  tooLong("providerAddress", provider.businessAddress, LIMITS.address);
  tooLong("providerPhone", provider.businessPhone, LIMITS.phone);
  tooLong("providerEmail", provider.email ?? "", LIMITS.email);

  const managerIds = texts(form, "managerId");
  const managerNames = texts(form, "managerName");
  const managerAddresses = texts(form, "managerAddress");
  const managerPhones = texts(form, "managerPhone");
  const managerEmails = texts(form, "managerEmail");
  const registeredManagers = managerIds.flatMap((id, i) => {
    const row = {
      id,
      fullName: managerNames[i] ?? "",
      businessAddress: managerAddresses[i] ?? "",
      businessPhone: managerPhones[i] ?? "",
      email: orNull(managerEmails[i] ?? ""),
    };
    if (!uuidLike.test(id)) return [];
    if (!row.fullName && !row.businessAddress && !row.businessPhone && !row.email) return [];
    tooLong(`managerName-${i}`, row.fullName, LIMITS.name);
    tooLong(`managerAddress-${i}`, row.businessAddress, LIMITS.address);
    tooLong(`managerPhone-${i}`, row.businessPhone, LIMITS.phone);
    tooLong(`managerEmail-${i}`, row.email ?? "", LIMITS.email);
    return [row];
  });

  const serviceAddress = text(form, "serviceAddress");
  tooLong("serviceAddress", serviceAddress, LIMITS.address);
  const consentsToEmailService = text(form, "consentsToEmailService") === "yes";
  const serviceEmail = orNull(text(form, "serviceEmail"));
  tooLong("serviceEmail", serviceEmail ?? "", LIMITS.email);
  const status = text(form, "legalStatus");
  const legalStatus = isLegalStatus(status) ? status : null;
  const legalStatusDetail = orNull(text(form, "legalStatusDetail"));
  tooLong("legalStatusDetail", legalStatusDetail ?? "", LIMITS.legalDetail);

  const locationIds = texts(form, "locationId");
  const locationNames = texts(form, "locationName");
  const locationAddresses = texts(form, "locationAddress");
  const locationCqcIds = texts(form, "locationCqcId");
  const locations = locationIds.flatMap((id, i) => {
    const row = {
      id,
      name: locationNames[i] ?? "",
      address: locationAddresses[i] ?? "",
      cqcLocationId: orNull(locationCqcIds[i] ?? ""),
    };
    if (!uuidLike.test(id)) return [];
    if (!row.name && !row.address && !row.cqcLocationId) return [];
    tooLong(`locationName-${i}`, row.name, LIMITS.name);
    tooLong(`locationAddress-${i}`, row.address, LIMITS.address);
    tooLong(`locationCqcId-${i}`, row.cqcLocationId ?? "", LIMITS.cqcLocationId);
    return [row];
  });

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    content: {
      aimsAndObjectives,
      serviceKinds,
      needsMet,
      provider,
      registeredManagers,
      serviceAddress,
      consentsToEmailService,
      serviceEmail,
      legalStatus,
      legalStatusDetail: legalStatus === "other" ? legalStatusDetail : null,
      locations,
    },
  };
}

type Version = StatementOfPurposeVersionItem;

const STATE_CHIPS: Record<Version["state"], Pick<QualityChip, "status" | "icon">> = {
  draft: { status: "neutral", icon: "file-pen" },
  approved: { status: "done", icon: "circle-check" },
  superseded: { status: "notApplicable", icon: "circle-minus" },
  discarded: { status: "notApplicable", icon: "circle-minus" },
};

export function versionStateChip(state: Version["state"], t: Translator): QualityChip {
  return { ...STATE_CHIPS[state], label: t("quality.sop.state", { state }) };
}

/**
 * Where a revision stands against the regulation 12(3) clock, as an icon and a word: due, overdue,
 * sent (or sent late), or not needed (a baseline). The API works out the state from its own times.
 */
export function notificationChip(
  notification: Version["notification"],
  t: Translator,
): QualityChip {
  switch (notification.state) {
    case "overdue":
      return {
        status: "overdue",
        icon: "circle-alert",
        label: t("quality.sop.clock", { clock: "overdue" }),
      };
    case "due":
      return { status: "due", icon: "clock", label: t("quality.sop.clock", { clock: "due" }) };
    case "notified":
      return notification.late
        ? { status: "done", icon: "circle-check", label: t("quality.sop.clock", { clock: "late" }) }
        : {
            status: "done",
            icon: "circle-check",
            label: t("quality.sop.clock", { clock: "sent" }),
          };
    default:
      return {
        status: "notApplicable",
        icon: "circle-minus",
        label: t("quality.sop.clock", { clock: "notRequired" }),
      };
  }
}

/** Approved or superseded revisions not yet sent to CQC, most urgent (earliest due) first. */
export function awaitingNotification(versions: readonly Version[]): Version[] {
  return versions
    .filter((v) => v.notification.state === "due" || v.notification.state === "overdue")
    .sort(
      (a, b) => Date.parse(a.notification.dueAt ?? "") - Date.parse(b.notification.dueAt ?? ""),
    );
}

export interface StatementView {
  readonly draft: Version | null;
  readonly current: Version | null;
  readonly startBaseline: boolean;
  readonly startRevision: boolean;
}

/** The draft, the version in force, and which start the writer may make. */
export function statementView(
  versions: readonly Version[],
  permissions: readonly string[],
): StatementView {
  const draft = versions.find((v) => v.state === "draft") ?? null;
  const current = versions.find((v) => v.state === "approved") ?? null;
  const settled = versions.some((v) => v.state === "approved" || v.state === "superseded");
  const write = permissions.includes(WRITE);
  return {
    draft,
    current,
    startBaseline: write && !draft && !settled,
    startRevision: write && !draft && settled,
  };
}

export type ApproveBlock = "no_permission" | "author" | "incomplete" | null;

/**
 * Whether this person may approve the draft, or why not in words: approval needs the permission,
 * someone who neither wrote nor edited it, and a statement complete against Schedule 3. Whether
 * it differs from the current version is the API's to say.
 */
export function approveBlock(
  draft: Pick<Version, "authorId" | "contributorIds" | "missing">,
  me: { readonly tenantUserId: string; readonly permissions: readonly string[] },
): ApproveBlock {
  if (!me.permissions.includes(APPROVE)) return "no_permission";
  if (draft.authorId === me.tenantUserId || draft.contributorIds.includes(me.tenantUserId)) {
    return "author";
  }
  if (draft.missing.length > 0) return "incomplete";
  return null;
}

/** The API's change summary lines and registration prompts, as text (the API's English). */
export function linesOf(values: readonly unknown[]): string[] {
  return values.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      for (const key of ["message", "line", "text"]) {
        if (typeof record[key] === "string") return [record[key] as string];
      }
      if (Array.isArray(record.lines)) {
        return record.lines.filter((l): l is string => typeof l === "string");
      }
    }
    return [];
  });
}

/** A new id for a manager or location row added in the editor (kept across edits). */
export function newRowId(): string {
  return globalThis.crypto.randomUUID();
}

export type NotifyRead =
  | {
      readonly ok: true;
      /** Null for "just now": the server action takes its own time (HZ-090). */
      readonly sentAt: string | null;
      readonly evidence: string;
    }
  | {
      readonly ok: false;
      readonly errors: FieldErrors;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

/**
 * Reads "record that it was sent to CQC": when, chosen every time (just now, or earlier with the
 * date and time, never in the future), and the CQC reference or how it was sent.
 */
export function readNotifyForm(form: FormValues, now: Date, t: Translator): NotifyRead {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const mode = text(form, "sentAt-mode");
  let sentAt: string | null = null;
  if (mode === "earlier") {
    const read = readDateTimeField(form, "sentAt", {
      subject: t("quality.sop.notify.subject"),
      t,
      now,
      // The API refuses a time after it receives the form.
      futureToleranceMinutes: 0,
    });
    if (read.ok && read.instant) sentAt = read.instant;
    else if (!read.ok) {
      errors.sentAt = read.message;
      parts.sentAt = read.parts;
    } else {
      errors.sentAt = t("quality.sop.notify.whenError");
    }
  } else if (mode !== "now") {
    errors.sentAt = t("quality.sop.notify.whenError");
  }
  const evidence = text(form, "evidence");
  if (!evidence || evidence.length > LIMITS.evidence) {
    errors.evidence = t("quality.sop.notify.evidenceError");
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
  }
  return { ok: true, sentAt, evidence };
}
