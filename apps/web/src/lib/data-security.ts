import type { Translator } from "@harbour/i18n";
import type { QualityChip } from "./evidence-packs";
import type { FormValues } from "./incident-forms";
import type { FieldErrors } from "./outcome";
import { readDateField, ukToday } from "./uk-time";

/**
 * The data security evidence screens (quality.md section 22; QUAL-012): where the DSPT, Cyber
 * Essentials and the ICO registration stand, the DSPT assertions with their evidence, submissions
 * and certificates. Pure helpers. A missing certificate is never shown as current; met without
 * evidence is said apart. The API checks every rule again.
 */

export const DSAR_MANAGE = "quality.dsar.manage";
export const dataSecurityShown = (permissions: readonly string[]) =>
  permissions.includes(DSAR_MANAGE);

export const ASSERTION_STATUSES = [
  "not_started",
  "in_progress",
  "met",
  "not_met",
  "not_applicable",
] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];
export const OUTCOMES = ["standards_met", "approaching_standards", "standards_not_met"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const CERTIFICATE_KINDS = [
  "cyber_essentials",
  "cyber_essentials_plus",
  "ico_registration",
] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];

export function dsptChip(
  status: "submitted" | "due" | "due_soon" | "overdue",
  deadline: string,
  t: Translator,
): QualityChip {
  const look = {
    submitted: { status: "done", icon: "circle-check" },
    due: { status: "info", icon: "clock" },
    due_soon: { status: "due", icon: "clock" },
    overdue: { status: "overdue", icon: "circle-alert" },
  } as const;
  return { ...look[status], label: t("quality.dataSecurity.dspt.status", { status, deadline }) };
}

/** A certificate's status. Missing is said as missing, with an alert icon: never current. */
export function renewalChip(
  status: "current" | "due_soon" | "expired" | "missing",
  t: Translator,
): QualityChip {
  const look = {
    current: { status: "done", icon: "circle-check" },
    due_soon: { status: "due", icon: "clock" },
    expired: { status: "overdue", icon: "circle-alert" },
    missing: { status: "overdue", icon: "circle-alert" },
  } as const;
  return { ...look[status], label: t("quality.dataSecurity.renewal", { status }) };
}

/**
 * Each record's place: the newest of its kind (latest issued; the first listed on a tie) is the
 * one the kind's status is about, and every older one is said as replaced, so it is never read
 * as current.
 */
export function latestOfKind(
  records: readonly { readonly id: string; readonly kind: string; readonly issuedOn: string }[],
): ReadonlySet<string> {
  const newest = new Map<string, { id: string; issuedOn: string }>();
  for (const r of records) {
    const seen = newest.get(r.kind);
    if (!seen || r.issuedOn > seen.issuedOn) newest.set(r.kind, { id: r.id, issuedOn: r.issuedOn });
  }
  return new Set([...newest.values()].map((r) => r.id));
}

export function replacedChip(t: Translator): QualityChip {
  return {
    status: "neutral",
    icon: "circle-minus",
    label: t("quality.dataSecurity.certificates.replaced"),
  };
}

export function assertionChip(status: AssertionStatus, t: Translator): QualityChip {
  const look = {
    not_started: { status: "neutral", icon: "circle-minus" },
    in_progress: { status: "due", icon: "pen-line" },
    met: { status: "done", icon: "circle-check" },
    not_met: { status: "overdue", icon: "circle-alert" },
    not_applicable: { status: "notApplicable", icon: "circle-minus" },
  } as const;
  return { ...look[status], label: t("quality.dataSecurity.assertion.status", { status }) };
}

/** Met with no evidence linked now: counted apart, and said, so it never reads as done. */
export function metWithoutEvidence(assertion: {
  readonly status: AssertionStatus;
  readonly evidence: readonly unknown[];
}): boolean {
  return assertion.status === "met" && assertion.evidence.length === 0;
}

const FINANCIAL_YEAR = /^[0-9]{4}\/[0-9]{2}$/;
export const isFinancialYear = (value: unknown): value is string =>
  typeof value === "string" && FINANCIAL_YEAR.test(value);

type Read<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly errors: FieldErrors;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

export function readAssertion(
  form: FormValues,
  financialYear: string,
  t: Translator,
): Read<{ financialYear: string; assertionRef: string; title: string }> {
  const errors: Record<string, string> = {};
  const assertionRef = String(form.get("assertionRef") ?? "").trim();
  const title = String(form.get("title") ?? "").trim();
  if (!/^[0-9]{1,2}(\.[0-9]{1,2}){1,3}$/.test(assertionRef)) {
    errors.assertionRef = t("quality.dataSecurity.form.refInvalid");
  }
  if (title.length < 3 || title.length > 500)
    errors.title = t("quality.dataSecurity.form.titleInvalid");
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, body: { financialYear, assertionRef, title } };
}

export function readAssertionStatus(
  form: FormValues,
  t: Translator,
): Read<{ status: AssertionStatus; notes: string | null }> {
  const status = String(form.get("status") ?? "");
  const notes = String(form.get("notes") ?? "").trim();
  const errors: Record<string, string> = {};
  if (!(ASSERTION_STATUSES as readonly string[]).includes(status)) {
    errors.status = t("quality.dataSecurity.form.statusMissing");
  }
  if ((status === "not_met" || status === "not_applicable") && !notes) {
    errors.notes = t("quality.dataSecurity.form.notesMissing");
  }
  if (notes.length > 4000) errors.notes = t("quality.dataSecurity.form.tooLong", { max: 4000 });
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, body: { status: status as AssertionStatus, notes: notes || null } };
}

export function readSubmission(
  form: FormValues,
  t: Translator,
  now: Date = new Date(),
): Read<{ submittedOn: string; outcome: Outcome; reference: string | null }> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const on = readDateField(form, "submittedOn", {
    subject: t("quality.dataSecurity.form.submittedSubject"),
    t,
  });
  if (!on.ok) {
    errors.submittedOn = on.message;
    parts.submittedOn = on.parts;
  } else if (on.date && on.date > ukToday(now)) {
    errors.submittedOn = t("quality.dataSecurity.form.notFuture", {
      subject: t("quality.dataSecurity.form.submittedSubject"),
    });
  }
  const outcome = String(form.get("outcome") ?? "");
  if (!(OUTCOMES as readonly string[]).includes(outcome))
    errors.outcome = t("quality.dataSecurity.form.outcomeMissing");
  const reference = String(form.get("reference") ?? "").trim();
  if (reference.length > 100)
    errors.reference = t("quality.dataSecurity.form.tooLong", { max: 100 });
  if (Object.keys(errors).length > 0 || !on.ok || !on.date) return { ok: false, errors, parts };
  return {
    ok: true,
    body: { submittedOn: on.date, outcome: outcome as Outcome, reference: reference || null },
  };
}

export function readCertificate(
  form: FormValues,
  documents: readonly string[],
  t: Translator,
  now: Date = new Date(),
): Read<{
  kind: CertificateKind;
  reference: string;
  issuedOn: string;
  expiresOn: string | null;
  issuer: string | null;
  documentId: string | null;
}> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const kind = String(form.get("kind") ?? "");
  if (!(CERTIFICATE_KINDS as readonly string[]).includes(kind))
    errors.kind = t("quality.dataSecurity.form.kindMissing");
  const reference = String(form.get("reference") ?? "").trim();
  if (reference.length < 1 || reference.length > 100)
    errors.reference = t("quality.dataSecurity.form.referenceMissing");
  const issued = readDateField(form, "issuedOn", {
    subject: t("quality.dataSecurity.form.issuedSubject"),
    t,
  });
  if (!issued.ok) {
    errors.issuedOn = issued.message;
    parts.issuedOn = issued.parts;
  } else if (issued.date && issued.date > ukToday(now)) {
    errors.issuedOn = t("quality.dataSecurity.form.notFuture", {
      subject: t("quality.dataSecurity.form.issuedSubject"),
    });
  }
  const expires = readDateField(form, "expiresOn", {
    subject: t("quality.dataSecurity.form.expiresSubject"),
    optional: true,
    t,
  });
  if (!expires.ok) {
    errors.expiresOn = expires.message;
    parts.expiresOn = expires.parts;
  } else if (issued.ok && issued.date && expires.date && expires.date <= issued.date) {
    errors.expiresOn = t("quality.dataSecurity.form.expiresBeforeIssue");
  }
  const issuer = String(form.get("issuer") ?? "").trim();
  if (issuer.length > 200) errors.issuer = t("quality.dataSecurity.form.tooLong", { max: 200 });
  const documentId = String(form.get("documentId") ?? "");
  if (documentId && !documents.includes(documentId))
    errors.documentId = t("quality.policies.form.documentMissing");
  if (Object.keys(errors).length > 0 || !issued.ok || !issued.date || !expires.ok) {
    return { ok: false, errors, parts };
  }
  return {
    ok: true,
    body: {
      kind: kind as CertificateKind,
      reference,
      issuedOn: issued.date,
      expiresOn: expires.date,
      issuer: issuer || null,
      documentId: documentId || null,
    },
  };
}
