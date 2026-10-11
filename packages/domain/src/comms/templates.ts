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
 * - Each field carries a data class: email subjects take no personal data and no multi-line field,
 *   and refuse control, line-separator and bidirectional characters (header injection); special
 *   category (health and care) details, NHS numbers and dates of birth never go in an email body,
 *   and incident follow-up and duty of candour templates are letters only (ADR-0051).
 * - Rendering escapes every value (and the template's own text) for HTML email, refuses a missing
 *   value rather than leaving a blank, refuses a value that belongs to another person (HZ-051),
 *   checks a duty of candour letter goes to the relevant person under regulation 20(7), and lists
 *   the personal-data fields it used for the audit trail.
 * - A letter's text is passed to the PDF renderer (Typst) as data, never as markup: nothing in a
 *   template or a value is interpreted as formatting.
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

/** Kinds that carry health and care details by their nature: letters only, never email. */
export const LETTER_ONLY_KINDS: readonly TemplateKind[] = ["incident_follow_up", "duty_of_candour"];

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
  /** The value may hold line breaks (an address, a written account): never in a subject. */
  readonly multiLine: boolean;
  /** Identifiers kept out of email bodies even though they are not special category data. */
  readonly notInEmail: boolean;
  /** The first written candour notification may say the results are still to follow. */
  readonly allowsResultsToFollow: boolean;
}

function mergeField(
  label: string,
  type: MergeFieldType,
  dataClass: MergeDataClass,
  personBound: boolean,
  options: {
    readonly multiLine?: boolean;
    readonly notInEmail?: boolean;
    readonly allowsResultsToFollow?: boolean;
  } = {},
): MergeFieldDefinition {
  return {
    label,
    type,
    dataClass,
    personBound,
    multiLine: options.multiLine ?? false,
    notInEmail: options.notInEmail ?? false,
    allowsResultsToFollow: options.allowsResultsToFollow ?? false,
  };
}

const MULTI_LINE = { multiLine: true } as const;

/** The catalogue. Money is in whole pence; dates are yyyy-mm-dd; date-times are ISO instants. */
export const MERGE_FIELDS = {
  "tenant.name": mergeField("Provider name", "text", "none", false),
  "location.name": mergeField("Home name", "text", "none", false),
  "location.address": mergeField("Home address", "text", "none", false, MULTI_LINE),
  "location.phone": mergeField("Home telephone number", "text", "none", false),
  "letter.date": mergeField("Date of the letter", "date", "none", false),
  "sender.name": mergeField("Sender's name", "text", "personal", false),
  "sender.role": mergeField("Sender's role", "text", "none", false),
  "person.full_name": mergeField("Person's full name", "text", "personal", true),
  "person.preferred_name": mergeField("Person's preferred name", "text", "personal", true),
  "person.room": mergeField("Person's room", "text", "personal", true),
  "person.date_of_birth": mergeField("Person's date of birth", "date", "personal", true, {
    notInEmail: true,
  }),
  "person.nhs_number": mergeField("Person's NHS number", "text", "personal", true, {
    notInEmail: true,
  }),
  "recipient.full_name": mergeField("Recipient's name", "text", "personal", true),
  "recipient.address": mergeField("Recipient's address", "text", "personal", true, MULTI_LINE),
  "recipient.relationship": mergeField(
    "Recipient's relationship to the person",
    "text",
    "personal",
    true,
  ),
  "admission.date": mergeField("Admission date", "date", "personal", true),
  "fee.current_weekly": mergeField("Current weekly fee", "money", "personal", true),
  "fee.new_weekly": mergeField("New weekly fee", "money", "personal", true),
  "fee.effective_date": mergeField("Date the new fee starts", "date", "personal", true),
  "fee.notice_days": mergeField(
    "Days' notice of a fee change (from the rate table)",
    "number",
    "none",
    false,
  ),
  "incident.date": mergeField("Date of the incident", "date", "special_category", true),
  "incident.summary": mergeField("What happened", "text", "special_category", true, MULTI_LINE),
  "candour.account": mergeField(
    "Account of the facts known",
    "text",
    "special_category",
    true,
    MULTI_LINE,
  ),
  "candour.enquiries": mergeField(
    "Further enquiries to be made",
    "text",
    "special_category",
    true,
    MULTI_LINE,
  ),
  "candour.results": mergeField("Results of further enquiries", "text", "special_category", true, {
    multiLine: true,
    allowsResultsToFollow: true,
  }),
  "candour.apology": mergeField("Apology", "text", "special_category", true, MULTI_LINE),
} as const satisfies Readonly<Record<string, MergeFieldDefinition>>;

export type MergeFieldKey = keyof typeof MERGE_FIELDS;

export function isMergeFieldKey(value: string): value is MergeFieldKey {
  return Object.hasOwn(MERGE_FIELDS, value);
}

function definitionOf(key: MergeFieldKey): MergeFieldDefinition {
  return MERGE_FIELDS[key];
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

/**
 * True when text holds a character that can break or disguise an email header: C0 and C1 control
 * characters (CR and LF among them), DEL, the Unicode line and paragraph separators, and the
 * bidirectional controls that can reorder what a reader sees.
 */
export function hasUnsafeHeaderCharacter(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
    if (c === 0x2028 || c === 0x2029) return true;
    if (c === 0x061c || c === 0x200e || c === 0x200f) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
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
  | "subject_unsafe_characters"
  | TemplateSyntaxProblem
  | "unknown_field"
  | "subject_personal_data"
  | "subject_multiline_field"
  | "letter_only_kind"
  | "special_category_in_email"
  | "identifier_in_email"
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
    subject_unsafe_characters:
      "The email subject has a hidden or line-break character in it. Retype the subject.",
    unterminated_field: "A merge field is not closed. Close it with }}.",
    invalid_field_name: `'${name}' is not a merge field name. Use lower case, for example {{person.preferred_name}}.`,
    stray_closing_braces: "There is a }} without a {{ before it.",
    unknown_field: `{{${name}}} is not a merge field Harbour knows. Choose one from the list.`,
    subject_personal_data: `Email subjects cannot include personal details. Remove {{${name}}} from the subject.`,
    subject_multiline_field: `{{${name}}} can run over several lines, so it cannot go in a subject.`,
    letter_only_kind:
      "Incident follow-up and duty of candour letters carry health details, so they are letters only.",
    special_category_in_email: `Health and care details cannot go in an email. Send this as a letter, or remove {{${name}}}.`,
    identifier_in_email: `{{${name}}} identifies the person and cannot go in an email. Send this as a letter, or remove it.`,
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
  if (isEmail && LETTER_ONLY_KINDS.includes(definition.kind)) {
    issues.push(issue("letter_only_kind", null));
  }
  const subjectText = isEmail ? (definition.subject ?? "").trim() : "";
  if (isEmail && subjectText.length === 0) issues.push(issue("subject_required", null));
  if (subjectText.length > MAX_TEMPLATE_SUBJECT_LENGTH) {
    issues.push(issue("subject_too_long", null));
  }
  if (isEmail && hasUnsafeHeaderCharacter(definition.subject ?? "")) {
    issues.push(issue("subject_unsafe_characters", null));
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
    if (!isMergeFieldKey(name)) continue;
    const field = definitionOf(name);
    if (field.dataClass !== "none") issues.push(issue("subject_personal_data", name));
    if (field.multiLine) issues.push(issue("subject_multiline_field", name));
  }
  if (isEmail) {
    for (const name of parsedBody.fields) {
      if (!isMergeFieldKey(name)) continue;
      const field = definitionOf(name);
      if (field.dataClass === "special_category") {
        issues.push(issue("special_category_in_email", name));
      } else if (field.notInEmail) {
        issues.push(issue("identifier_in_email", name));
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
    personalDataFields: known.filter((f) => definitionOf(f).dataClass !== "none"),
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
// The duty of candour's relevant person (regulation 20(7))
// ------------------------------------------------------------------------------------------------

/** The circumstances in regulation 20(7) in which a representative is the relevant person. */
export const CANDOUR_REPRESENTATIVE_BASES = [
  "death",
  "under_16_not_competent",
  "lacks_capacity",
] as const;

export type CandourRepresentativeBasis = (typeof CANDOUR_REPRESENTATIVE_BASES)[number];

/** The relevant person recorded on the candour record (safety module). */
export type CandourRelevantPerson =
  | { readonly kind: "service_user"; readonly personId: string }
  | {
      readonly kind: "representative";
      readonly personId: string;
      readonly contactId: string;
      readonly basis: CandourRepresentativeBasis;
    };

export type CandourRelevantPersonProblem =
  | "representative_basis_not_met"
  | "representative_required";

/**
 * Regulation 20(7): "relevant person" means the service user or, on their death, where they are
 * under 16 and not competent, or where they are 16 or over and lack capacity in relation to the
 * matter, a person lawfully acting on their behalf. Checks the candour record's choice against the
 * facts recorded for the person (wording to confirm with the CSO and a solicitor, H-103).
 */
export function checkCandourRelevantPerson(
  relevantPerson: CandourRelevantPerson,
  facts: {
    readonly died: boolean;
    readonly under16NotCompetent: boolean;
    readonly lacksCapacityForMatter: boolean;
  },
): readonly CandourRelevantPersonProblem[] {
  const applies: Record<CandourRepresentativeBasis, boolean> = {
    death: facts.died,
    under_16_not_competent: facts.under16NotCompetent,
    lacks_capacity: facts.lacksCapacityForMatter,
  };
  if (relevantPerson.kind === "representative") {
    return applies[relevantPerson.basis] ? [] : ["representative_basis_not_met"];
  }
  return Object.values(applies).some(Boolean) ? ["representative_required"] : [];
}

export type LetterRecipient =
  | { readonly kind: "person"; readonly personId: string }
  | { readonly kind: "contact"; readonly personId: string; readonly contactId: string };

function sameRecipient(relevantPerson: CandourRelevantPerson, recipient: LetterRecipient): boolean {
  if (relevantPerson.kind === "service_user") {
    return recipient.kind === "person" && recipient.personId === relevantPerson.personId;
  }
  return (
    recipient.kind === "contact" &&
    recipient.personId === relevantPerson.personId &&
    recipient.contactId === relevantPerson.contactId
  );
}

// ------------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------------

/** The first written candour notification may say the results of enquiries are still to come. */
export interface ResultsToFollow {
  readonly kind: "results_to_follow";
  /** yyyy-mm-dd when the provider expects to write with the results, or null if not known. */
  readonly expectedBy: string | null;
}

export interface MergeValue {
  readonly value: string | number | ResultsToFollow;
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
  /** Required for a duty of candour letter: the candour record's relevant person and the recipient. */
  readonly candour?: {
    readonly relevantPerson: CandourRelevantPerson;
    readonly recipient: LetterRecipient;
  } | null;
}

export interface RenderedTemplate {
  readonly templateVersionId: string;
  readonly channel: TemplateChannel;
  readonly subject: string | null;
  /** Plain text; for a letter, passed to the PDF renderer as data, never as markup. */
  readonly text: string;
  /** Email only: every value and every piece of template text HTML-escaped. */
  readonly html: string | null;
  readonly fieldsUsed: readonly MergeFieldKey[];
  /** For the audit trail and the "check before sending" screen. */
  readonly personalDataFields: readonly MergeFieldKey[];
  readonly containsSpecialCategory: boolean;
  /** A candour letter whose results are still to come: the candour workflow keeps a letter due. */
  readonly resultsToFollow: boolean;
  readonly subjectPersonId: string | null;
}

export type TemplateRenderProblem =
  | "not_approved"
  | "invalid_template"
  | "subject_person_required"
  | "missing_value"
  | "wrong_type"
  | "wrong_person"
  | "candour_recipient_required"
  | "candour_wrong_recipient"
  | "subject_not_generic"
  | "subject_unsafe_characters";

export const TEMPLATE_RENDER_MESSAGES: Readonly<Record<TemplateRenderProblem, string>> = {
  not_approved: "This template version is not approved for use.",
  invalid_template: "This template has problems. Ask for it to be corrected and approved again.",
  subject_person_required: "Choose the person this letter is about.",
  missing_value: "Some details are missing. Add them before the letter is made.",
  wrong_type: "Some details are in the wrong format.",
  wrong_person:
    "Some details belong to a different person. The letter was not made. Check who it is for.",
  candour_recipient_required:
    "Choose who the duty of candour letter goes to, from the candour record.",
  candour_wrong_recipient:
    "A duty of candour letter goes to the relevant person named on the candour record.",
  subject_not_generic: "The email subject must not contain personal details.",
  subject_unsafe_characters: "The email subject has a hidden or line-break character in it.",
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

function ukDateText(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
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
      return typeof value === "string" && isIsoDate(value) ? ukDateText(value) : null;
    case "datetime": {
      if (typeof value !== "string") return null;
      const instant = new Date(value);
      return Number.isNaN(instant.getTime()) ? null : formatUkDateTime(instant);
    }
  }
}

/** The standard words for results still to come (regulation 20(4)(c) once they are known). */
export function resultsToFollowText(marker: ResultsToFollow): string | null {
  if (marker.expectedBy !== null && !isIsoDate(marker.expectedBy)) return null;
  return marker.expectedBy === null
    ? "The results of our further enquiries are not available yet. We will write to you with them as soon as they are."
    : `The results of our further enquiries are not available yet. We will write to you with them by ${ukDateText(marker.expectedBy)}.`;
}

function isResultsToFollow(value: MergeValue["value"]): value is ResultsToFollow {
  return typeof value === "object" && value !== null && value.kind === "results_to_follow";
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
  const personBound = used.filter((f) => definitionOf(f).personBound);
  if (personBound.length > 0 && request.subjectPersonId === null) {
    fail("subject_person_required", personBound);
  }
  if (version.kind === "duty_of_candour") {
    const candour = request.candour ?? null;
    if (candour === null) fail("candour_recipient_required");
    else if (
      !sameRecipient(candour.relevantPerson, candour.recipient) ||
      candour.relevantPerson.personId !== request.subjectPersonId
    ) {
      fail("candour_wrong_recipient");
    }
  }
  const missing: string[] = [];
  const wrongType: string[] = [];
  const wrongPerson: string[] = [];
  const formatted = new Map<string, string>();
  let resultsToFollow = false;
  for (const field of used) {
    const supplied = request.values[field];
    if (!supplied || (typeof supplied.value === "string" && supplied.value.trim() === "")) {
      missing.push(field);
      continue;
    }
    const fieldDefinition = definitionOf(field);
    let text: string | null;
    if (isResultsToFollow(supplied.value)) {
      text = fieldDefinition.allowsResultsToFollow ? resultsToFollowText(supplied.value) : null;
      if (text !== null) resultsToFollow = true;
    } else {
      text = formatMergeValue(fieldDefinition.type, supplied.value);
    }
    if (text === null) wrongType.push(field);
    else formatted.set(field, text);
    if (
      fieldDefinition.personBound &&
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
    if (problems.length === 0 && hasUnsafeHeaderCharacter(subject)) {
      fail("subject_unsafe_characters");
    } else if (problems.length === 0 && outboundTitleProblem(subject) !== null) {
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
      containsSpecialCategory: used.some((f) => definitionOf(f).dataClass === "special_category"),
      resultsToFollow,
      subjectPersonId: request.subjectPersonId,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Retention of a letter
// ------------------------------------------------------------------------------------------------

/**
 * A letter is kept with the record it belongs to: incident follow-up and candour letters follow
 * the incident's grade (`serious_incident` only when the incident is graded serious), every other
 * letter the person's `care_record` (retention.md).
 */
export function letterRetentionClass(letter: {
  readonly kind: TemplateKind;
  readonly incidentSerious: boolean | null;
}): "care_record" | "serious_incident" {
  return LETTER_ONLY_KINDS.includes(letter.kind) && letter.incidentSerious === true
    ? "serious_incident"
    : "care_record";
}
