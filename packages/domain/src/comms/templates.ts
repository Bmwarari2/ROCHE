import { outboundTitleProblem } from "../integrations/ports";
import { defineWorkflow } from "../platform/workflow";
import { type Citation, cite } from "../shared/citation";
import { formatUkDateTime } from "../shared/time";

/**
 * Letter and email templates (master prompt 15.1, templates and letters row: "merge-field letters
 * and emails (admission, fee review, incident follow-up, duty of candour) with approval and
 * audit"; comms.md section 4; hazard HZ-051; ADR-0051).
 *
 * - Merge fields are typed and catalogued; a template that names an unknown field is refused.
 * - Each field carries a data class: email subjects take no personal data, and special category
 *   (health and care) details never go in an email body: they go by letter (ADR-0051).
 * - Rendering escapes every value (and the template's own text) for HTML email, refuses a missing
 *   value rather than leaving a blank, refuses a value that belongs to another person (HZ-051),
 *   and lists the personal-data fields it used for the audit trail.
 * - Only an approved version is used. The author cannot approve it; an approved version never
 *   changes, so any change is a new version that needs approval again.
 *
 * The parser is a loop over the text, not a regular expression, so it cannot backtrack on long
 * input (the CodeQL polynomial-ReDoS gate).
 */

export const TEMPLATE_KINDS = [
  "admission",
  "fee_review",
  "incident_follow_up",
  "duty_of_candour",
  "general",
] as const;

export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_CHANNELS = ["letter", "email"] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

export const MERGE_FIELD_TYPES = ["text", "date", "datetime", "money", "number"] as const;
export type MergeFieldType = (typeof MERGE_FIELD_TYPES)[number];

/** `none`: no personal data; `personal`; `special_category`: health or care details (UK GDPR Art 9). */
export const MERGE_DATA_CLASSES = ["none", "personal", "special_category"] as const;
export type MergeDataClass = (typeof MERGE_DATA_CLASSES)[number];

export interface MergeFieldDefinition {
  readonly label: string;
  readonly type: MergeFieldType;
  readonly dataClass: MergeDataClass;
  /**
   * The value belongs to one person receiving care (their own data, or a contact of theirs), so it
   * must belong to the person the letter is about (HZ-051).
   */
  readonly personBound: boolean;
}

/** The catalogue. Money is in whole pence; dates are yyyy-mm-dd; date-times are ISO instants. */
export const MERGE_FIELDS = {
  "tenant.name": { label: "Provider name", type: "text", dataClass: "none", personBound: false },
  "location.name": { label: "Home name", type: "text", dataClass: "none", personBound: false },
  "location.address": {
    label: "Home address",
    type: "text",
    dataClass: "none",
    personBound: false,
  },
  "location.phone": {
    label: "Home telephone number",
    type: "text",
    dataClass: "none",
    personBound: false,
  },
  "letter.date": {
    label: "Date of the letter",
    type: "date",
    dataClass: "none",
    personBound: false,
  },
  "sender.name": {
    label: "Sender's name",
    type: "text",
    dataClass: "personal",
    personBound: false,
  },
  "sender.role": { label: "Sender's role", type: "text", dataClass: "none", personBound: false },
  "person.full_name": {
    label: "Person's full name",
    type: "text",
    dataClass: "personal",
    personBound: true,
  },
  "person.preferred_name": {
    label: "Person's preferred name",
    type: "text",
    dataClass: "personal",
    personBound: true,
  },
  "person.room": { label: "Person's room", type: "text", dataClass: "personal", personBound: true },
  "person.date_of_birth": {
    label: "Person's date of birth",
    type: "date",
    dataClass: "personal",
    personBound: true,
  },
  "person.nhs_number": {
    label: "Person's NHS number",
    type: "text",
    dataClass: "personal",
    personBound: true,
  },
  "recipient.full_name": {
    label: "Recipient's name",
    type: "text",
    dataClass: "personal",
    personBound: true,
  },
  "recipient.address": {
    label: "Recipient's address",
    type: "text",
    dataClass: "personal",
    personBound: true,
  },
  "recipient.relationship": {
    label: "Recipient's relationship to the person",
    type: "text",
    dataClass: "personal",
    personBound: true,
  },
  "admission.date": {
    label: "Admission date",
    type: "date",
    dataClass: "personal",
    personBound: true,
  },
  "fee.current_weekly": {
    label: "Current weekly fee",
    type: "money",
    dataClass: "personal",
    personBound: true,
  },
  "fee.new_weekly": {
    label: "New weekly fee",
    type: "money",
    dataClass: "personal",
    personBound: true,
  },
  "fee.effective_date": {
    label: "Date the new fee starts",
    type: "date",
    dataClass: "personal",
    personBound: true,
  },
  "fee.notice_days": {
    label: "Days' notice of a fee change (from the rate table)",
    type: "number",
    dataClass: "none",
    personBound: false,
  },
  "incident.date": {
    label: "Date of the incident",
    type: "date",
    dataClass: "special_category",
    personBound: true,
  },
  "incident.summary": {
    label: "What happened",
    type: "text",
    dataClass: "special_category",
    personBound: true,
  },
  "candour.account": {
    label: "Account of the facts known",
    type: "text",
    dataClass: "special_category",
    personBound: true,
  },
  "candour.enquiries": {
    label: "Further enquiries to be made",
    type: "text",
    dataClass: "special_category",
    personBound: true,
  },
  "candour.results": {
    label: "Results of further enquiries",
    type: "text",
    dataClass: "special_category",
    personBound: true,
  },
  "candour.apology": {
    label: "Apology",
    type: "text",
    dataClass: "special_category",
    personBound: true,
  },
} as const satisfies Readonly<Record<string, MergeFieldDefinition>>;

export type MergeFieldKey = keyof typeof MERGE_FIELDS;

export function isMergeFieldKey(value: string): value is MergeFieldKey {
  return Object.hasOwn(MERGE_FIELDS, value);
}

const CANDOUR_REG_20 = "https://www.legislation.gov.uk/uksi/2014/2936/regulation/20";
const REG_20_SOURCE = "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014";

/** Fields a template of a kind must contain, with the rule that requires them. */
export const TEMPLATE_REQUIRED_FIELDS: Readonly<
  Record<TemplateKind, readonly { readonly field: MergeFieldKey; readonly citation: Citation }[]>
> = {
  admission: [],
  fee_review: [],
  incident_follow_up: [],
  general: [],
  duty_of_candour: [
    { field: "candour.account", citation: cite(REG_20_SOURCE, "reg 20(4)(a)", CANDOUR_REG_20) },
    { field: "candour.enquiries", citation: cite(REG_20_SOURCE, "reg 20(4)(b)", CANDOUR_REG_20) },
    { field: "candour.results", citation: cite(REG_20_SOURCE, "reg 20(4)(c)", CANDOUR_REG_20) },
    { field: "candour.apology", citation: cite(REG_20_SOURCE, "reg 20(4)(d)", CANDOUR_REG_20) },
  ],
};

// ------------------------------------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------------------------------------

/** Why: a letter, not a book; bounds the work done on any one template. */
export const MAX_TEMPLATE_BODY_LENGTH = 20_000;
/** Why: email subjects show in inbox previews; the outbound title rule allows 80 characters. */
export const MAX_TEMPLATE_SUBJECT_LENGTH = 80;
const MAX_FIELD_NAME_LENGTH = 64;

export type TemplatePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "field"; readonly key: string };

export type TemplateSyntaxProblem =
  | "unterminated_field"
  | "invalid_field_name"
  | "stray_closing_braces";

export interface ParsedTemplate {
  readonly parts: readonly TemplatePart[];
  /** Field names in order of first use, unique. */
  readonly fields: readonly string[];
  readonly problems: readonly { readonly problem: TemplateSyntaxProblem; readonly text: string }[];
}

function isFieldName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_FIELD_NAME_LENGTH) return false;
  const first = value.charCodeAt(0);
  if (first < 97 || first > 122) return false;
  let previous = "";
  for (const ch of value) {
    const lower = ch >= "a" && ch <= "z";
    const digit = ch >= "0" && ch <= "9";
    if (!lower && !digit && ch !== "_" && ch !== ".") return false;
    if (ch === "." && previous === ".") return false;
    previous = ch;
  }
  return previous !== ".";
}

/** Splits template text into literal text and `{{ field.name }}` parts. */
export function parseTemplateText(text: string): ParsedTemplate {
  const parts: TemplatePart[] = [];
  const fields: string[] = [];
  const problems: { problem: TemplateSyntaxProblem; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    const chunk = text.slice(i, open === -1 ? text.length : open);
    if (chunk.includes("}}")) problems.push({ problem: "stray_closing_braces", text: "}}" });
    if (chunk.length > 0) parts.push({ kind: "text", text: chunk });
    if (open === -1) break;
    const close = text.indexOf("}}", open + 2);
    if (close === -1) {
      problems.push({ problem: "unterminated_field", text: text.slice(open, open + 20) });
      parts.push({ kind: "text", text: text.slice(open) });
      break;
    }
    const name = text.slice(open + 2, close).trim();
    if (isFieldName(name)) {
      parts.push({ kind: "field", key: name });
      if (!fields.includes(name)) fields.push(name);
    } else {
      problems.push({ problem: "invalid_field_name", text: name.slice(0, MAX_FIELD_NAME_LENGTH) });
    }
    i = close + 2;
  }
  return { parts, fields, problems };
}

// ------------------------------------------------------------------------------------------------
// Checking a template definition
// ------------------------------------------------------------------------------------------------

export interface TemplateDefinition {
  readonly kind: TemplateKind;
  readonly channel: TemplateChannel;
  /** Email only; letters have none. */
  readonly subject: string | null;
  readonly body: string;
}

export type TemplateProblem =
  | "body_empty"
  | "body_too_long"
  | "subject_required"
  | "subject_too_long"
  | TemplateSyntaxProblem
  | "unknown_field"
  | "subject_personal_data"
  | "special_category_in_email"
  | "required_field_missing";

export interface TemplateIssue {
  readonly problem: TemplateProblem;
  /** The field or text the issue is about, if any. */
  readonly subjectText: string | null;
  readonly message: string;
}

export interface TemplateDefinitionCheck {
  readonly ok: boolean;
  readonly issues: readonly TemplateIssue[];
  /** Catalogued fields used in the subject or body. */
  readonly fields: readonly MergeFieldKey[];
  /** Fields used that hold personal or special category data (shown before sending, audited). */
  readonly personalDataFields: readonly MergeFieldKey[];
}

function issue(problem: TemplateProblem, subjectText: string | null): TemplateIssue {
  const name = subjectText ?? "";
  const messages: Record<TemplateProblem, string> = {
    body_empty: "Write the letter.",
    body_too_long: "This template is too long. Split it into shorter letters.",
    subject_required: "An email needs a subject.",
    subject_too_long: "Keep the email subject to 80 characters or fewer.",
    unterminated_field: "A merge field is not closed. Close it with }}.",
    invalid_field_name: `'${name}' is not a merge field name. Use lower case, for example {{person.preferred_name}}.`,
    stray_closing_braces: "There is a }} without a {{ before it.",
    unknown_field: `{{${name}}} is not a merge field Harbour knows. Choose one from the list.`,
    subject_personal_data: `Email subjects cannot include personal details. Remove {{${name}}} from the subject.`,
    special_category_in_email: `Health and care details cannot go in an email. Send this as a letter, or remove {{${name}}}.`,
    required_field_missing: `This kind of letter must include {{${name}}}.`,
  };
  return { problem, subjectText, message: messages[problem] };
}

/** Checks a template's text and fields before it is saved or approved. */
export function checkTemplateDefinition(definition: TemplateDefinition): TemplateDefinitionCheck {
  const issues: TemplateIssue[] = [];
  const body = definition.body.trim();
  if (body.length === 0) issues.push(issue("body_empty", null));
  if (definition.body.length > MAX_TEMPLATE_BODY_LENGTH) issues.push(issue("body_too_long", null));
  const isEmail = definition.channel === "email";
  const subjectText = isEmail ? (definition.subject ?? "").trim() : "";
  if (isEmail && subjectText.length === 0) issues.push(issue("subject_required", null));
  if (subjectText.length > MAX_TEMPLATE_SUBJECT_LENGTH) {
    issues.push(issue("subject_too_long", null));
  }

  const parsedBody = parseTemplateText(
    definition.body.length > MAX_TEMPLATE_BODY_LENGTH ? "" : definition.body,
  );
  const parsedSubject = parseTemplateText(subjectText);
  for (const p of [...parsedSubject.problems, ...parsedBody.problems]) {
    issues.push(issue(p.problem, p.text));
  }
  const known: MergeFieldKey[] = [];
  for (const name of [...parsedSubject.fields, ...parsedBody.fields]) {
    if (!isMergeFieldKey(name)) {
      issues.push(issue("unknown_field", name));
    } else if (!known.includes(name)) {
      known.push(name);
    }
  }
  for (const name of parsedSubject.fields) {
    if (isMergeFieldKey(name) && MERGE_FIELDS[name].dataClass !== "none") {
      issues.push(issue("subject_personal_data", name));
    }
  }
  if (isEmail) {
    for (const name of parsedBody.fields) {
      if (isMergeFieldKey(name) && MERGE_FIELDS[name].dataClass === "special_category") {
        issues.push(issue("special_category_in_email", name));
      }
    }
  }
  for (const required of TEMPLATE_REQUIRED_FIELDS[definition.kind]) {
    if (!parsedBody.fields.includes(required.field)) {
      issues.push(issue("required_field_missing", required.field));
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    fields: known,
    personalDataFields: known.filter((f) => MERGE_FIELDS[f].dataClass !== "none"),
  };
}

// ------------------------------------------------------------------------------------------------
// Versions and approval
// ------------------------------------------------------------------------------------------------

export type TemplateVersionState = "draft" | "approved" | "superseded" | "retired" | "discarded";

/**
 * Draft to approved (not by its author) to superseded (when the next version is approved) or
 * retired. Approved versions never change: a change is a new draft, approved again.
 */
export const TEMPLATE_WORKFLOW = defineWorkflow<TemplateVersionState>({
  key: "comms.template",
  version: 1,
  states: ["draft", "approved", "superseded", "retired", "discarded"],
  initial: "draft",
  terminal: ["superseded", "retired", "discarded"],
  transitions: [
    {
      from: "draft",
      to: "approved",
      permission: "comms.template.approve",
      distinctFromCreator: true,
    },
    { from: "draft", to: "discarded", permission: "comms.template.write", requiresReason: true },
    { from: "approved", to: "superseded", permission: "comms.template.approve" },
    { from: "approved", to: "retired", permission: "comms.template.approve", requiresReason: true },
  ],
});

export interface TemplateVersion extends TemplateDefinition {
  readonly id: string;
  readonly templateId: string;
  readonly version: number;
  readonly name: string;
  readonly state: TemplateVersionState;
  readonly authorId: string;
  /** Everyone who edited this version, the author included. */
  readonly contributorIds: readonly string[];
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
}

export type TemplateApprovalProblem =
  | "not_draft"
  | "missing_permission"
  | "author_cannot_approve"
  | "invalid_template"
  | "no_changes";

export const TEMPLATE_APPROVAL_MESSAGES: Readonly<Record<TemplateApprovalProblem, string>> = {
  not_draft: "Only a draft can be approved.",
  missing_permission: "Your role does not allow you to approve templates.",
  author_cannot_approve: "Someone who did not write or edit this version must approve it.",
  invalid_template: "Fix the problems in the template first.",
  no_changes: "This version is the same as the approved one.",
};

function sameDefinition(a: TemplateVersion, b: TemplateVersion): boolean {
  return (
    a.kind === b.kind &&
    a.channel === b.channel &&
    a.name.trim() === b.name.trim() &&
    (a.subject ?? "").trim() === (b.subject ?? "").trim() &&
    a.body === b.body
  );
}

/** Separation of duties: nobody who wrote or edited a version approves it (comms.md rule 5). */
export function checkTemplateApproval(
  draft: TemplateVersion,
  current: TemplateVersion | null,
  approver: { readonly id: string; readonly permissions: ReadonlySet<string> },
): readonly TemplateApprovalProblem[] {
  const problems: TemplateApprovalProblem[] = [];
  if (draft.state !== "draft") problems.push("not_draft");
  if (!approver.permissions.has("comms.template.approve")) problems.push("missing_permission");
  if (draft.authorId === approver.id || draft.contributorIds.includes(approver.id)) {
    problems.push("author_cannot_approve");
  }
  if (!checkTemplateDefinition(draft).ok) problems.push("invalid_template");
  if (current !== null && sameDefinition(current, draft)) problems.push("no_changes");
  return problems;
}

export type TemplateEditCheck =
  | { readonly ok: true; readonly contributorIds: readonly string[] }
  | { readonly ok: false; readonly problem: "approved_versions_are_fixed" | "missing_permission" };

/** Only drafts change; the editor joins the contributors, so they cannot approve it either. */
export function checkTemplateEdit(
  version: Pick<TemplateVersion, "state" | "contributorIds">,
  editor: { readonly id: string; readonly permissions: ReadonlySet<string> },
): TemplateEditCheck {
  if (version.state !== "draft") return { ok: false, problem: "approved_versions_are_fixed" };
  if (!editor.permissions.has("comms.template.write")) {
    return { ok: false, problem: "missing_permission" };
  }
  return {
    ok: true,
    contributorIds: version.contributorIds.includes(editor.id)
      ? version.contributorIds
      : [...version.contributorIds, editor.id],
  };
}

/** A change to an approved template starts here: a new draft that needs approval again. */
export function startTemplateRevision(
  current: TemplateVersion,
  newId: string,
  authorId: string,
): TemplateVersion {
  return {
    ...current,
    id: newId,
    version: current.version + 1,
    state: "draft",
    authorId,
    contributorIds: [authorId],
    approvedBy: null,
    approvedAt: null,
  };
}

/** The version in use: the approved one (there is at most one per template). */
export function currentApprovedTemplate(
  versions: readonly TemplateVersion[],
  templateId: string,
): TemplateVersion | null {
  const approved = versions
    .filter((v) => v.templateId === templateId && v.state === "approved")
    .sort((a, b) => b.version - a.version);
  return approved[0] ?? null;
}

// ------------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------------

export interface MergeValue {
  readonly value: string | number;
  /**
   * For person-bound fields, the person receiving care the value belongs to (for recipient
   * fields, the person whose contact the recipient is). Null for other fields.
   */
  readonly personId: string | null;
}

export interface TemplateRenderRequest {
  /** The person the letter is about; required when any person-bound field is used. */
  readonly subjectPersonId: string | null;
  readonly values: Readonly<Record<string, MergeValue>>;
}

export interface RenderedTemplate {
  readonly templateVersionId: string;
  readonly channel: TemplateChannel;
  readonly subject: string | null;
  readonly text: string;
  /** Email only: every value and every piece of template text HTML-escaped. */
  readonly html: string | null;
  readonly fieldsUsed: readonly MergeFieldKey[];
  /** For the audit trail and the "check before sending" screen. */
  readonly personalDataFields: readonly MergeFieldKey[];
  readonly containsSpecialCategory: boolean;
  readonly subjectPersonId: string | null;
}

export type TemplateRenderProblem =
  | "not_approved"
  | "invalid_template"
  | "subject_person_required"
  | "missing_value"
  | "wrong_type"
  | "wrong_person"
  | "subject_not_generic";

export const TEMPLATE_RENDER_MESSAGES: Readonly<Record<TemplateRenderProblem, string>> = {
  not_approved: "This template version is not approved for use.",
  invalid_template: "This template has problems. Ask for it to be corrected and approved again.",
  subject_person_required: "Choose the person this letter is about.",
  missing_value: "Some details are missing. Add them before the letter is made.",
  wrong_type: "Some details are in the wrong format.",
  wrong_person:
    "Some details belong to a different person. The letter was not made. Check who it is for.",
  subject_not_generic: "The email subject must not contain personal details.",
};

export type TemplateRenderResult =
  | { readonly ok: true; readonly rendered: RenderedTemplate }
  | {
      readonly ok: false;
      readonly problems: readonly {
        readonly problem: TemplateRenderProblem;
        readonly fields: readonly string[];
        readonly message: string;
      }[];
    };

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for an HTML email body or attribute. */
export function escapeHtml(text: string): string {
  let out = "";
  for (const ch of text) out += HTML_ESCAPES[ch] ?? ch;
  return out;
}

const moneyFormatter = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

function isIsoDate(value: string): boolean {
  if (value.length !== 10) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Formats a value for its field type, or null when the value is not of that type. */
export function formatMergeValue(type: MergeFieldType, value: string | number): string | null {
  switch (type) {
    case "text":
      return typeof value === "string" ? value.trim() : null;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
    case "money":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? moneyFormatter.format(value / 100)
        : null;
    case "date":
      return typeof value === "string" && isIsoDate(value)
        ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`
        : null;
    case "datetime": {
      if (typeof value !== "string") return null;
      const instant = new Date(value);
      return Number.isNaN(instant.getTime()) ? null : formatUkDateTime(instant);
    }
  }
}

function toHtml(parts: readonly TemplatePart[], values: ReadonlyMap<string, string>): string {
  let escaped = "";
  for (const part of parts) {
    escaped += escapeHtml(part.kind === "text" ? part.text : (values.get(part.key) ?? ""));
  }
  return escaped
    .split("\r\n")
    .join("\n")
    .split("\n\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p.split("\n").join("<br>")}</p>`)
    .join("\n");
}

function toText(parts: readonly TemplatePart[], values: ReadonlyMap<string, string>): string {
  return parts.map((p) => (p.kind === "text" ? p.text : (values.get(p.key) ?? ""))).join("");
}

/** Makes a letter or email from an approved version and the values for one person. */
export function renderTemplate(
  version: TemplateVersion,
  request: TemplateRenderRequest,
): TemplateRenderResult {
  const problems: { problem: TemplateRenderProblem; fields: string[]; message: string }[] = [];
  const fail = (problem: TemplateRenderProblem, fields: string[] = []) =>
    problems.push({ problem, fields, message: TEMPLATE_RENDER_MESSAGES[problem] });
  if (version.state !== "approved") fail("not_approved");
  const definition = checkTemplateDefinition(version);
  if (!definition.ok) {
    fail("invalid_template");
    return { ok: false, problems };
  }
  const used = definition.fields;
  const personBound = used.filter((f) => MERGE_FIELDS[f].personBound);
  if (personBound.length > 0 && request.subjectPersonId === null) {
    fail("subject_person_required", personBound);
  }
  const missing: string[] = [];
  const wrongType: string[] = [];
  const wrongPerson: string[] = [];
  const formatted = new Map<string, string>();
  for (const field of used) {
    const supplied = request.values[field];
    if (!supplied || (typeof supplied.value === "string" && supplied.value.trim() === "")) {
      missing.push(field);
      continue;
    }
    const text = formatMergeValue(MERGE_FIELDS[field].type, supplied.value);
    if (text === null) wrongType.push(field);
    else formatted.set(field, text);
    if (
      MERGE_FIELDS[field].personBound &&
      request.subjectPersonId !== null &&
      supplied.personId !== request.subjectPersonId
    ) {
      wrongPerson.push(field);
    }
  }
  if (wrongPerson.length > 0) fail("wrong_person", wrongPerson);
  if (missing.length > 0) fail("missing_value", missing);
  if (wrongType.length > 0) fail("wrong_type", wrongType);
  let subject: string | null = null;
  if (version.channel === "email") {
    subject = toText(parseTemplateText((version.subject ?? "").trim()).parts, formatted).trim();
    if (problems.length === 0 && outboundTitleProblem(subject) !== null) {
      fail("subject_not_generic");
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  const body = parseTemplateText(version.body);
  return {
    ok: true,
    rendered: {
      templateVersionId: version.id,
      channel: version.channel,
      subject,
      text: toText(body.parts, formatted),
      html: version.channel === "email" ? toHtml(body.parts, formatted) : null,
      fieldsUsed: used,
      personalDataFields: definition.personalDataFields,
      containsSpecialCategory: used.some((f) => MERGE_FIELDS[f].dataClass === "special_category"),
      subjectPersonId: request.subjectPersonId,
    },
  };
}
