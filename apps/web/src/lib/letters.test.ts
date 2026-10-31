import type { LetterTemplateItem, LetterTemplateVersionItem } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  emailTemplatesLeftOut,
  issueField,
  issuesByField,
  mergeFieldNames,
  penceFrom,
  readDraft,
  templateActions,
  templateName,
  templatesForLetters,
  templatesNavShown,
  typedFieldsOf,
  versionChip,
} from "./letters";

const ME = "0194d000-0000-7000-8000-000000000302";
const OTHER = "0194d000-0000-7000-8000-000000000301";

const version = (over: Partial<LetterTemplateVersionItem> = {}): LetterTemplateVersionItem => ({
  id: "0194d000-0000-7000-8000-00000000a001",
  templateId: "0194d000-0000-7000-8000-00000000b001",
  versionNumber: 1,
  state: "draft",
  name: "Welcome letter",
  subject: null,
  body: "Dear {{recipient.full_name}}",
  authorId: OTHER,
  contributorIds: [OTHER],
  approvedBy: null,
  approvedAt: null,
  retiredAt: null,
  retirementReason: null,
  discardReason: null,
  issues: [],
  personalDataFields: [],
  styleWarnings: [],
  version: 1,
  ...over,
});

const template = (over: Partial<LetterTemplateItem> = {}): LetterTemplateItem => ({
  id: "0194d000-0000-7000-8000-00000000b001",
  kind: "general",
  channel: "letter",
  currentVersionId: null,
  current: null,
  draft: version(),
  version: 1,
  ...over,
});

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe("hazard HZ-051 letter templates on the web", () => {
  it.each([
    ["subject_personal_data", "subject"],
    ["subject_too_long", "subject"],
    ["letter_only_kind", "channel"],
    ["special_category_in_email", "body"],
    ["unknown_field", "body"],
    ["required_field_missing", "body"],
  ] as const)("shows %s at the %s field", (problem, field) => {
    expect(issueField(problem)).toBe(field);
  });

  it("joins several problems at one field", () => {
    expect(
      issuesByField([
        { problem: "subject_personal_data", message: "A." },
        { problem: "subject_unsafe_characters", message: "B." },
        { problem: "unknown_field", message: "C." },
      ]),
    ).toEqual({ subject: "A. B.", body: "C." });
  });

  it("asks for a subject only for an email, and checks the limits", () => {
    expect(readDraft(form({ name: " Welcome ", body: "Hello" }), "letter", t)).toEqual({
      ok: true,
      name: "Welcome",
      subject: null,
      body: "Hello",
    });
    const email = readDraft(form({ name: "", subject: "", body: " " }), "email", t);
    expect(email.ok).toBe(false);
    if (!email.ok) expect(Object.keys(email.errors).sort()).toEqual(["body", "name", "subject"]);
  });

  it("never offers approval to the author or an editor, and says why", () => {
    const approver = ["comms.template.approve", "comms.template.write"];
    expect(templateActions(template(), approver, ME)).toMatchObject({
      approve: true,
      ownDraft: false,
      edit: true,
    });
    const edited = template({ draft: version({ contributorIds: [OTHER, ME] }) });
    expect(templateActions(edited, approver, ME)).toMatchObject({ approve: false, ownDraft: true });
    expect(templateActions(template(), ["comms.letter.manage"], ME)).toMatchObject({
      approve: false,
      edit: false,
      retire: false,
    });
  });

  it("offers a new draft only from a version in use, and retiring only to approvers", () => {
    const inUse = template({ draft: null, current: version({ state: "approved" }) });
    expect(templateActions(inUse, ["comms.template.write"], ME)).toMatchObject({
      startDraft: true,
      retire: false,
    });
    expect(templateActions(inUse, ["comms.template.approve"], ME).retire).toBe(true);
  });

  it("shows state as an icon and a word", () => {
    expect(versionChip("approved", t)).toMatchObject({ icon: "circle-check", label: "In use" });
    expect(versionChip("draft", t).label).toBe("Draft");
    expect(templatesNavShown(["comms.letter.manage"])).toBe(true);
    expect(templateName(template({ draft: null }), t)).toBe("General letter, no version in use");
    expect(templatesNavShown(["care.note.read"])).toBe(false);
  });
});

describe("hazard HZ-051 making a letter on the web", () => {
  it("asks only for the typed details the version uses", () => {
    expect(
      typedFieldsOf({
        subject: null,
        body: "From {{fee.effective_date}} the fee is {{fee.new_weekly}} for {{person.full_name}}.",
      }).map((f) => f.key),
    ).toEqual(["fee.new_weekly", "fee.effective_date"]);
  });

  it.each([
    ["1,250.50", 125050],
    ["£980", 98000],
    ["12.5", 1250],
    ["", null],
    ["12.345", null],
    ["-5", null],
    ["ten pounds", null],
  ] as const)("reads %s as %s pence", (typed, pence) => {
    expect(penceFrom(typed)).toBe(pence);
  });

  it("offers only templates in use, never candour, and incident letters only to incident managers", () => {
    const inUse = (kind: LetterTemplateItem["kind"]) =>
      template({ kind, current: version({ state: "approved" }), draft: null });
    const all = [
      inUse("general"),
      inUse("duty_of_candour"),
      inUse("incident_follow_up"),
      template(),
      template({
        kind: "general",
        channel: "email",
        current: version({ state: "approved" }),
        draft: null,
      }),
    ];
    expect(templatesForLetters(all, false).map((x) => x.kind)).toEqual(["general"]);
    expect(templatesForLetters(all, true).map((x) => x.kind)).toEqual([
      "general",
      "incident_follow_up",
    ]);
  });
});

describe("email templates while sending email is not built", () => {
  it("leaves email templates out of the letters tab, and says one was left out", () => {
    const email = template({
      kind: "general",
      channel: "email",
      current: version({ state: "approved" }),
      draft: null,
    });
    expect(templatesForLetters([email], true)).toEqual([]);
    expect(emailTemplatesLeftOut([email])).toBe(true);
    expect(emailTemplatesLeftOut([template()])).toBe(false);
  });
});

describe("the personal details a letter uses, in words", () => {
  it("names each merge field, never its key, and keeps an unknown key", () => {
    expect(mergeFieldNames(["person.full_name", "person.date_of_birth"])).toBe(
      "Person's full name, Person's date of birth",
    );
    expect(mergeFieldNames(["not.a.field"])).toBe("not.a.field");
  });
});
