import type { LetterTemplateItem, LetterTemplateVersionItem } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  issueField,
  issuesByField,
  readDraft,
  templateActions,
  templateName,
  templatesNavShown,
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
