import type { LetterTemplateItem, LetterTemplateVersionItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import type { FieldErrors } from "./outcome";

/**
 * Letter and email templates on the web (comms.md rules 18 to 23; COMMS-007; HZ-051). The API
 * checks every draft as it is saved and every approval; these helpers only say what it found, at
 * the field it is about, and decide which actions to offer.
 */

export const TEMPLATE_WRITE = "comms.template.write";
export const TEMPLATE_APPROVE = "comms.template.approve";
export const LETTER_MANAGE = "comms.letter.manage";

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

/** Limits the API checks; the form checks them first so the person is told at the field. */
export const NAME_MAX = 200;
export const SUBJECT_MAX = 80;
export const BODY_MAX = 20_000;
export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** The templates link in the side bar: for anyone who writes, approves or sends from them. */
export function templatesNavShown(permissions: readonly string[]): boolean {
  return [TEMPLATE_WRITE, TEMPLATE_APPROVE, LETTER_MANAGE].some((p) => permissions.includes(p));
}

/**
 * A template's name: the version in use, else its draft; a retired template with neither is named
 * by its kind and channel, so its link is never empty.
 */
export function templateName(template: LetterTemplateItem, t: Translator): string {
  return (
    template.current?.name ??
    template.draft?.name ??
    t("comms.templates.retiredName", { kind: template.kind, channel: template.channel })
  );
}

/** Which field of the form an issue the API found is about. */
export function issueField(problem: string): "subject" | "channel" | "body" {
  if (problem.startsWith("subject_")) return "subject";
  if (problem === "letter_only_kind") return "channel";
  return "body";
}

/** The API's problems with a draft, each at its field (several at one field are joined). */
export function issuesByField(
  issues: readonly { readonly problem: string; readonly message: string }[],
): FieldErrors {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = issueField(issue.problem);
    out[field] = out[field] ? `${out[field]} ${issue.message}` : issue.message;
  }
  return out;
}

export type DraftRead =
  | {
      readonly ok: true;
      readonly name: string;
      readonly subject: string | null;
      readonly body: string;
    }
  | { readonly ok: false; readonly errors: FieldErrors };

type FormValues = Pick<FormData, "get">;

/** The draft's words as typed, or what to fix first (the API checks the merge fields). */
export function readDraft(form: FormValues, channel: TemplateChannel, t: Translator): DraftRead {
  const name = String(form.get("name") ?? "").trim();
  const subject = String(form.get("subject") ?? "").trim();
  const body = String(form.get("body") ?? "");
  const errors: Record<string, string> = {};
  if (name.length === 0 || name.length > NAME_MAX) {
    errors.name = t("comms.templates.form.nameError", { max: NAME_MAX });
  }
  if (channel === "email" && (subject.length === 0 || subject.length > SUBJECT_MAX)) {
    errors.subject = t("comms.templates.form.subjectError", { max: SUBJECT_MAX });
  }
  if (body.trim().length === 0 || body.length > BODY_MAX) {
    errors.body = t("comms.templates.form.bodyError", { max: BODY_MAX });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, name, subject: channel === "email" ? subject : null, body };
}

/** A version's state as an icon and a word, never colour alone. */
export function versionChip(state: LetterTemplateVersionItem["state"], t: Translator): SafetyChip {
  const label = t("comms.templates.state", { state });
  switch (state) {
    case "approved":
      return { status: "done", icon: "circle-check", label };
    case "draft":
      return { status: "info", icon: "file-pen", label };
    default:
      return { status: "neutral", icon: "circle-minus", label };
  }
}

/** What the viewer may do with a template now, as the API would allow it. */
export function templateActions(
  template: LetterTemplateItem,
  permissions: readonly string[],
  tenantUserId: string,
) {
  const write = permissions.includes(TEMPLATE_WRITE);
  const approve = permissions.includes(TEMPLATE_APPROVE);
  const draft = template.draft;
  const shaped = draft
    ? draft.authorId === tenantUserId || draft.contributorIds.includes(tenantUserId)
    : false;
  return {
    edit: write && draft !== null,
    discard: write && draft !== null,
    startDraft: write && draft === null && template.current !== null,
    /** Approval is offered only to someone who neither wrote nor edited the draft (rule 22). */
    approve: approve && draft !== null && !shaped,
    /** Why approval is not offered to this approver, when that is the reason. */
    ownDraft: approve && draft !== null && shaped,
    retire: approve && template.current !== null,
  };
}

// ------------------------------------------------------------------------------------------------
// Letters on a person's record (rules 24 and 25)
// ------------------------------------------------------------------------------------------------

/** The details the sender types (the API's `SENDER_TYPED_FIELDS`); all else is from the record. */
export const TYPED_FIELDS = [
  { key: "admission.date", type: "date" },
  { key: "fee.current_weekly", type: "money" },
  { key: "fee.new_weekly", type: "money" },
  { key: "fee.effective_date", type: "date" },
] as const;
export type TypedField = (typeof TYPED_FIELDS)[number];

/** The typed details a version uses, in the catalogue's order. */
export function typedFieldsOf(version: {
  readonly subject: string | null;
  readonly body: string;
}): TypedField[] {
  const text = `${version.subject ?? ""}\n${version.body}`;
  return TYPED_FIELDS.filter((field) => text.includes(`{{${field.key}}}`));
}

/** Pounds and pence as typed ("1,250.50", "£980") in whole pence, or null when not a sum. */
export function penceFrom(value: string): number | null {
  const plain = value.trim().replace(/^£/, "").replaceAll(",", "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(plain)) return null;
  const [pounds = "0", pence = ""] = plain.split(".");
  return Number(pounds) * 100 + Number(pence.padEnd(2, "0"));
}

/** Templates a letter can be made from here: in use, and of a kind this screen can make. */
export function templatesForLetters(
  templates: readonly LetterTemplateItem[],
  canUseIncidents: boolean,
): LetterTemplateItem[] {
  return templates.filter(
    (template) =>
      template.current !== null &&
      template.kind !== "duty_of_candour" &&
      (canUseIncidents || template.kind !== "incident_follow_up"),
  );
}
