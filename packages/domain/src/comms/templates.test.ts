import { describe, expect, it } from "vitest";
import { builtinRole } from "../platform/roles";
import { checkWorkflowTransition } from "../platform/workflow";
import { citationText } from "../shared/citation";
import {
  type CandourRelevantPerson,
  checkCandourRelevantPerson,
  checkTemplateApproval,
  checkTemplateDefinition,
  checkTemplateEdit,
  currentApprovedTemplate,
  escapeHtml,
  formatMergeValue,
  hasUnsafeHeaderCharacter,
  type LetterRecipient,
  letterRetentionClass,
  MERGE_DATA_CLASSES,
  MERGE_FIELD_TYPES,
  MERGE_FIELDS,
  type MergeFieldKey,
  type MergeValue,
  parseTemplateText,
  renderTemplate,
  resultsToFollowText,
  startTemplateRevision,
  TEMPLATE_APPROVAL_MESSAGES,
  TEMPLATE_REQUIRED_FIELDS,
  TEMPLATE_WORKFLOW,
  type TemplateDefinition,
  type TemplateRenderRequest,
  type TemplateVersion,
} from "./templates";

/** Letter and email templates (comms.md section 4). Hazard HZ-051. */

const ADA = "person-ada";
const BEN = "person-ben";
const permissionsOf = (role: string) => new Set(builtinRole(role)?.permissions ?? []);

function version(o: Partial<TemplateVersion> = {}): TemplateVersion {
  return {
    id: "tv-1",
    templateId: "t-fee",
    version: 1,
    name: "Fee review letter",
    kind: "fee_review",
    channel: "letter",
    subject: null,
    body: "Dear {{recipient.full_name}},\n\nThe weekly fee for {{person.preferred_name}} changes from {{fee.current_weekly}} to {{fee.new_weekly}} on {{fee.effective_date}}.\n\n{{sender.name}}, {{sender.role}}",
    state: "approved",
    authorId: "staff-admin",
    contributorIds: ["staff-admin"],
    approvedBy: "staff-manager",
    approvedAt: new Date("2026-10-01T09:00:00Z"),
    ...o,
  };
}

const own = (value: string | number): MergeValue => ({ value, personId: ADA });
const plain = (value: string | number): MergeValue => ({ value, personId: null });

function values(o: Record<string, MergeValue> = {}): TemplateRenderRequest {
  return {
    subjectPersonId: ADA,
    values: {
      "recipient.full_name": own("Ben Example"),
      "person.preferred_name": own("Addie"),
      "fee.current_weekly": own(125_000),
      "fee.new_weekly": own(131_250),
      "fee.effective_date": own("2027-04-01"),
      "sender.name": plain("Rita Manager"),
      "sender.role": plain("Registered Manager"),
      ...o,
    },
  };
}

describe("the merge field catalogue", () => {
  it("types and classifies every field", () => {
    for (const [key, field] of Object.entries(MERGE_FIELDS)) {
      expect(field.label.length, key).toBeGreaterThan(3);
      expect(MERGE_FIELD_TYPES).toContain(field.type);
      expect(MERGE_DATA_CLASSES).toContain(field.dataClass);
    }
  });

  it("binds every field about a person or their contacts to that person", () => {
    const bound = (Object.keys(MERGE_FIELDS) as MergeFieldKey[]).filter(
      (k) => MERGE_FIELDS[k].personBound,
    );
    for (const key of bound) {
      expect(["person", "recipient", "admission", "fee", "incident", "candour"]).toContain(
        key.split(".")[0],
      );
      expect(MERGE_FIELDS[key].dataClass).not.toBe("none");
    }
    expect(MERGE_FIELDS["fee.notice_days"].personBound).toBe(false);
  });

  it("treats incident and candour details as special category data", () => {
    for (const key of Object.keys(MERGE_FIELDS) as MergeFieldKey[]) {
      if (key.startsWith("incident.") || key.startsWith("candour.")) {
        expect(MERGE_FIELDS[key].dataClass).toBe("special_category");
      }
    }
  });

  it("requires the regulation 20(4) contents in a duty of candour letter", () => {
    expect(
      TEMPLATE_REQUIRED_FIELDS.duty_of_candour.map((r) => [r.field, citationText(r.citation)]),
    ).toEqual([
      [
        "candour.account",
        "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014 reg 20(4)(a)",
      ],
      [
        "candour.enquiries",
        "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014 reg 20(4)(b)",
      ],
      [
        "candour.results",
        "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014 reg 20(4)(c)",
      ],
      [
        "candour.apology",
        "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014 reg 20(4)(d)",
      ],
    ]);
  });
});

describe("template permissions", () => {
  it.each([
    ["registered_manager", true, true],
    ["quality_lead", true, true],
    ["administrator", true, false],
    ["clinical_lead", false, false],
    ["care_worker", false, false],
  ] as const)("%s writes: %s, approves: %s", (role, write, approve) => {
    const permissions = permissionsOf(role);
    expect(permissions.has("comms.template.write")).toBe(write);
    expect(permissions.has("comms.template.approve")).toBe(approve);
  });
});

describe("parsing", () => {
  it.each<[string, string, string[], string[]]>([
    ["plain text", "Dear family,", [], []],
    [
      "two fields",
      "Hello {{ person.preferred_name }} and {{recipient.full_name}}",
      ["person.preferred_name", "recipient.full_name"],
      [],
    ],
    ["a field used twice", "{{tenant.name}} {{tenant.name}}", ["tenant.name"], []],
    ["an unclosed field", "Dear {{recipient.full_name", [], ["unterminated_field"]],
    ["a bad field name", "Dear {{Recipient Name}}", [], ["invalid_field_name"]],
    ["nested braces", "{{a {{b}}", [], ["invalid_field_name"]],
    ["a trailing dot", "{{person.}}", [], ["invalid_field_name"]],
    ["a double dot", "{{person..name}}", [], ["invalid_field_name"]],
    ["a leading digit", "{{1person}}", [], ["invalid_field_name"]],
    ["an empty field", "{{ }}", [], ["invalid_field_name"]],
    ["stray closing braces", "Total }} here", [], ["stray_closing_braces"]],
  ])("%s", (_label, text, fields, problems) => {
    const parsed = parseTemplateText(text);
    expect(parsed.fields).toEqual(fields);
    expect(parsed.problems.map((p) => p.problem)).toEqual(problems);
  });

  it("stays fast on long hostile input", () => {
    const hostile = "{{a".repeat(20_000);
    const started = Date.now();
    parseTemplateText(hostile);
    parseTemplateText("{".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("checking a template", () => {
  const def = (o: Partial<TemplateDefinition>): TemplateDefinition => ({
    kind: "general",
    channel: "letter",
    subject: null,
    body: "Dear {{recipient.full_name}},",
    ...o,
  });

  it.each<[string, Partial<TemplateDefinition>, string[]]>([
    ["a valid letter", {}, []],
    ["an empty letter", { body: "  " }, ["body_empty"]],
    ["a letter that is too long", { body: "x".repeat(20_001) }, ["body_too_long"]],
    ["an unknown field", { body: "Dear {{person.nickname}}" }, ["unknown_field"]],
    ["an unclosed field", { body: "Dear {{person.full_name" }, ["unterminated_field"]],
    [
      "an email without a subject",
      { channel: "email", body: "Hello {{recipient.full_name}}" },
      ["subject_required"],
    ],
    [
      "an email subject that is too long",
      { channel: "email", subject: "x".repeat(81), body: "Hello" },
      ["subject_too_long"],
    ],
    [
      "personal data in an email subject",
      { channel: "email", subject: "News about {{person.preferred_name}}", body: "Hello" },
      ["subject_personal_data"],
    ],
    [
      "health details in an email",
      {
        channel: "email",
        subject: "A message from {{location.name}}",
        body: "{{incident.summary}}",
      },
      ["special_category_in_email"],
    ],
    [
      "a duty of candour letter with no apology",
      {
        kind: "duty_of_candour",
        body: "{{candour.account}} {{candour.enquiries}} {{candour.results}}",
      },
      ["required_field_missing"],
    ],
    [
      "a complete duty of candour letter",
      {
        kind: "duty_of_candour",
        body: "{{candour.account}} {{candour.enquiries}} {{candour.results}} {{candour.apology}}",
      },
      [],
    ],
    ["health details in a letter", { body: "On {{incident.date}}: {{incident.summary}}" }, []],
  ])("%s", (_label, o, problems) => {
    expect(checkTemplateDefinition(def(o)).issues.map((i) => i.problem)).toEqual(problems);
  });

  it("names the field in each message", () => {
    const check = checkTemplateDefinition(def({ body: "{{person.nickname}}" }));
    expect(check.issues[0]?.message).toBe(
      "{{person.nickname}} is not a merge field Harbour knows. Choose one from the list.",
    );
  });

  it("flags the personal-data fields a template uses", () => {
    const check = checkTemplateDefinition(version());
    expect(check.personalDataFields).toEqual([
      "recipient.full_name",
      "person.preferred_name",
      "fee.current_weekly",
      "fee.new_weekly",
      "fee.effective_date",
      "sender.name",
    ]);
    expect(check.fields).toContain("sender.role");
  });
});

describe("approval: the author cannot approve, and a change needs approval again", () => {
  const draft = version({
    id: "tv-2",
    version: 2,
    state: "draft",
    body: `${version().body}\n\nThank you.`,
    authorId: "staff-admin",
    contributorIds: ["staff-admin"],
    approvedBy: null,
    approvedAt: null,
  });
  const by = (id: string, role: string) => ({ id, permissions: permissionsOf(role) });

  it.each<[string, Partial<TemplateVersion>, ReturnType<typeof by>, string[]]>([
    ["a manager approving someone else's draft", {}, by("staff-manager", "registered_manager"), []],
    ["the author", {}, by("staff-admin", "registered_manager"), ["author_cannot_approve"]],
    [
      "someone who edited the draft",
      { contributorIds: ["staff-admin", "staff-manager"] },
      by("staff-manager", "registered_manager"),
      ["author_cannot_approve"],
    ],
    ["an administrator", {}, by("staff-admin-2", "administrator"), ["missing_permission"]],
    [
      "an approved version",
      { state: "approved" },
      by("staff-manager", "registered_manager"),
      ["not_draft"],
    ],
    [
      "a draft with problems",
      { body: "{{person.nickname}}" },
      by("staff-manager", "registered_manager"),
      ["invalid_template"],
    ],
    [
      "a draft identical to the approved version",
      { body: version().body },
      by("staff-manager", "registered_manager"),
      ["no_changes"],
    ],
  ])("%s", (_label, o, approver, problems) => {
    expect(checkTemplateApproval({ ...draft, ...o }, version(), approver)).toEqual(problems);
  });

  it("enforces the same rule in the workflow", () => {
    const check = checkWorkflowTransition(
      TEMPLATE_WORKFLOW,
      { state: "draft", createdBy: "staff-manager" },
      {
        to: "approved",
        actorId: "staff-manager",
        permissions: permissionsOf("registered_manager"),
        stepUpFresh: false,
      },
    );
    expect(check).toMatchObject({ ok: false, problem: "separation_of_duties" });
  });

  it("never changes an approved version: edits start a new draft", () => {
    expect(checkTemplateEdit(version(), by("staff-admin", "administrator"))).toEqual({
      ok: false,
      problem: "approved_versions_are_fixed",
    });
    const next = startTemplateRevision(version(), "tv-3", "staff-admin");
    expect(next).toMatchObject({
      id: "tv-3",
      version: 2,
      state: "draft",
      contributorIds: ["staff-admin"],
      approvedBy: null,
    });
  });

  it("adds every editor to the contributors, so they cannot approve it", () => {
    expect(checkTemplateEdit(draft, by("staff-manager", "registered_manager"))).toEqual({
      ok: true,
      contributorIds: ["staff-admin", "staff-manager"],
    });
    expect(checkTemplateEdit(draft, by("staff-admin", "administrator"))).toEqual({
      ok: true,
      contributorIds: ["staff-admin"],
    });
    expect(checkTemplateEdit(draft, by("staff-carer", "care_worker"))).toEqual({
      ok: false,
      problem: "missing_permission",
    });
  });

  it("uses the approved version while a change waits for approval", () => {
    const versions = [
      version({ id: "tv-0", version: 0, state: "superseded" }),
      version(),
      draft,
      version({ id: "tv-other", templateId: "t-other" }),
    ];
    expect(currentApprovedTemplate(versions, "t-fee")?.id).toBe("tv-1");
    expect(currentApprovedTemplate([draft], "t-fee")).toBeNull();
  });

  it("has a message for every problem", () => {
    for (const m of Object.values(TEMPLATE_APPROVAL_MESSAGES)) expect(m.length).toBeGreaterThan(10);
  });
});

describe("rendering", () => {
  it("makes the letter with every value formatted", () => {
    const result = renderTemplate(version(), values());
    expect(result.ok && result.rendered.text).toBe(
      "Dear Ben Example,\n\nThe weekly fee for Addie changes from £1,250.00 to £1,312.50 on 01/04/2027.\n\nRita Manager, Registered Manager",
    );
    expect(result).toMatchObject({
      ok: true,
      rendered: { channel: "letter", html: null, subject: null, containsSpecialCategory: false },
    });
    expect(result.ok && result.rendered.personalDataFields).toContain("person.preferred_name");
  });

  it("escapes values and the template's own text for HTML email", () => {
    const email = version({
      channel: "email",
      kind: "general",
      subject: "A message from {{location.name}}",
      body: "Dear {{recipient.full_name}},\n\nFish & chips on Friday.\nSee you there.",
    });
    const result = renderTemplate(email, {
      subjectPersonId: ADA,
      values: {
        "recipient.full_name": own('<script>alert("x")</script> O\'Neil'),
        "location.name": plain("Harbour House"),
      },
    });
    expect(result.ok && result.rendered.subject).toBe("A message from Harbour House");
    expect(result.ok && result.rendered.html).toBe(
      "<p>Dear &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; O&#39;Neil,</p>\n<p>Fish &amp; chips on Friday.<br>See you there.</p>",
    );
  });

  it("hazard HZ-051 only an approved version can be used", () => {
    for (const state of ["draft", "superseded", "retired", "discarded"] as const) {
      const result = renderTemplate(version({ state }), values());
      expect(result.ok ? null : result.problems.map((p) => p.problem)).toEqual(["not_approved"]);
    }
  });

  it("refuses a version whose text no longer passes the checks", () => {
    const result = renderTemplate(version({ body: "{{person.nickname}}" }), values());
    expect(result.ok ? null : result.problems.map((p) => p.problem)).toEqual(["invalid_template"]);
  });

  it.each<[string, TemplateRenderRequest, string, string[]]>([
    [
      "hazard HZ-051 refuses to merge details that belong to another person",
      values({ "person.preferred_name": { value: "Benny", personId: BEN } }),
      "wrong_person",
      ["person.preferred_name"],
    ],
    [
      "hazard HZ-051 refuses a recipient who is another person's contact",
      values({ "recipient.full_name": { value: "Cara Other", personId: BEN } }),
      "wrong_person",
      ["recipient.full_name"],
    ],
    [
      "hazard HZ-051 refuses a person-bound value with no person",
      values({ "fee.new_weekly": plain(131_250) }),
      "wrong_person",
      ["fee.new_weekly"],
    ],
    [
      "hazard HZ-051 refuses a letter with a missing value rather than leaving it blank",
      (() => {
        const { "fee.effective_date": _omitted, ...rest } = values().values;
        return { subjectPersonId: ADA, values: rest };
      })(),
      "missing_value",
      ["fee.effective_date"],
    ],
    ["a blank value", values({ "sender.name": plain("  ") }), "missing_value", ["sender.name"]],
    [
      "money in pounds rather than whole pence",
      values({ "fee.new_weekly": own(1312.5) }),
      "wrong_type",
      ["fee.new_weekly"],
    ],
    [
      "an impossible date",
      values({ "fee.effective_date": own("2027-02-30") }),
      "wrong_type",
      ["fee.effective_date"],
    ],
    [
      "a number given as text",
      values({ "fee.current_weekly": own("1250") }),
      "wrong_type",
      ["fee.current_weekly"],
    ],
  ])("%s", (_label, request, problem, fields) => {
    const result = renderTemplate(version(), request);
    expect(result.ok ? null : result.problems.map((p) => [p.problem, p.fields])).toEqual([
      [problem, fields],
    ]);
  });

  it("hazard HZ-051 needs the person the letter is about", () => {
    const result = renderTemplate(version(), { ...values(), subjectPersonId: null });
    expect(result.ok ? null : result.problems.map((p) => p.problem)).toEqual([
      "subject_person_required",
    ]);
  });

  it("renders a template with no person-bound fields without a person", () => {
    const notice = version({
      kind: "general",
      body: "{{tenant.name}} will test the fire alarm on {{letter.date}}. Notice: {{fee.notice_days}} days.",
    });
    const result = renderTemplate(notice, {
      subjectPersonId: null,
      values: {
        "tenant.name": plain("Example Care Homes Ltd"),
        "letter.date": plain("2026-10-14"),
        "fee.notice_days": plain(28),
      },
    });
    expect(result.ok && result.rendered.text).toBe(
      "Example Care Homes Ltd will test the fire alarm on 14/10/2026. Notice: 28 days.",
    );
    expect(result.ok && result.rendered.personalDataFields).toEqual([]);
  });

  it("refuses an email subject that would carry personal details", () => {
    const email = version({
      channel: "email",
      kind: "general",
      subject: "Update from {{location.name}}",
      body: "Hello",
    });
    const result = renderTemplate(email, {
      subjectPersonId: null,
      values: { "location.name": plain("Ward ada@example.invalid") },
    });
    expect(result.ok ? null : result.problems.map((p) => p.problem)).toEqual([
      "subject_not_generic",
    ]);
  });

  it("marks letters that carry health details", () => {
    const letter = version({
      kind: "incident_follow_up",
      body: "On {{incident.date}} {{person.preferred_name}} had a fall: {{incident.summary}}",
    });
    const result = renderTemplate(letter, {
      subjectPersonId: ADA,
      values: {
        "incident.date": own("2026-10-10"),
        "person.preferred_name": own("Addie"),
        "incident.summary": own("bruised left hip"),
      },
    });
    expect(result.ok && result.rendered.containsSpecialCategory).toBe(true);
  });
});

describe("formatting values", () => {
  it.each<[Parameters<typeof formatMergeValue>[0], string | number, string | null]>([
    ["text", " Addie ", "Addie"],
    ["text", 5, null],
    ["number", 28, "28"],
    ["number", Number.NaN, null],
    ["number", "28", null],
    ["money", 123_456, "£1,234.56"],
    ["money", 0, "£0.00"],
    ["money", 12.5, null],
    ["date", "2026-10-11", "11/10/2026"],
    ["date", "11/10/2026", null],
    ["date", 20261011, null],
    ["datetime", "2026-10-11T13:05:00Z", "11/10/2026 14:05"],
    ["datetime", "2026-12-11T13:05:00Z", "11/12/2026 13:05"],
    ["datetime", "not a time", null],
    ["datetime", 1, null],
  ])("%s %s gives %s", (type, value, expected) => {
    expect(formatMergeValue(type, value)).toBe(expected);
  });

  it("escapes the five HTML-special characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });
});

describe("hazard HZ-051 email subjects cannot carry hidden characters or several lines", () => {
  it.each<[string, string, boolean]>([
    ["plain text", "A message from Harbour House", false],
    ["a carriage return and line feed", "Hello\r\nBcc: someone@example.invalid", true],
    ["a lone line feed", "Hello\nthere", true],
    ["a tab", "Hello\tthere", true],
    ["a null character", "Hello\u0000", true],
    ["DEL", "Hello\u007F", true],
    ["a C1 control (next line)", "Hello\u0085there", true],
    ["the Unicode line separator", "Hello there", true],
    ["the Unicode paragraph separator", "Hello there", true],
    ["a right-to-left override", "Invoice ‮fdp.exe", true],
    ["a right-to-left isolate", "Hello ⁧there⁩", true],
    ["a right-to-left mark", "Hello‏", true],
    ["an Arabic letter mark", "Hello؜", true],
    ["an accented letter", "Café update", false],
  ])("%s: %s", (_label, text, unsafe) => {
    expect(hasUnsafeHeaderCharacter(text)).toBe(unsafe);
  });

  const email = (subject: string) =>
    checkTemplateDefinition({
      kind: "general",
      channel: "email",
      subject,
      body: "Hello",
    }).issues.map((i) => i.problem);

  it.each<[string, string, string[]]>([
    [
      "a subject with a line break",
      "News\r\nBcc: x@example.invalid",
      ["subject_unsafe_characters"],
    ],
    ["a subject with a bidi override", "News ‮", ["subject_unsafe_characters"]],
    [
      "a multi-line field in the subject",
      "News from {{location.address}}",
      ["subject_multiline_field"],
    ],
    ["a single-line field in the subject", "News from {{location.name}}", []],
  ])("refuses %s", (_label, subject, problems) => {
    expect(email(subject)).toEqual(problems);
  });

  it("refuses a rendered subject whose value smuggles in a line break", () => {
    const template = version({
      kind: "general",
      channel: "email",
      subject: "News from {{location.name}}",
      body: "Hello",
    });
    const result = renderTemplate(template, {
      subjectPersonId: null,
      values: { "location.name": { value: "Harbour\r\nBcc: x@example.invalid", personId: null } },
    });
    expect(result.ok ? null : result.problems.map((p) => p.problem)).toEqual([
      "subject_unsafe_characters",
    ]);
  });
});

describe("hazard HZ-051 health details and identifiers stay out of email", () => {
  const check = (o: Partial<TemplateDefinition>) =>
    checkTemplateDefinition({
      kind: "general",
      channel: "email",
      subject: "A message from {{location.name}}",
      body: "Hello",
      ...o,
    }).issues.map((i) => i.problem);

  it.each<[string, Partial<TemplateDefinition>, string[]]>([
    ["an incident follow-up by email", { kind: "incident_follow_up" }, ["letter_only_kind"]],
    [
      "a duty of candour letter by email",
      {
        kind: "duty_of_candour",
        body: "{{candour.account}} {{candour.enquiries}} {{candour.results}} {{candour.apology}}",
      },
      [
        "letter_only_kind",
        "special_category_in_email",
        "special_category_in_email",
        "special_category_in_email",
        "special_category_in_email",
      ],
    ],
    [
      "an NHS number in an email body",
      { body: "Ref {{person.nhs_number}}" },
      ["identifier_in_email"],
    ],
    [
      "a date of birth in an email body",
      { body: "Born {{person.date_of_birth}}" },
      ["identifier_in_email"],
    ],
    ["a preferred name in an email body", { body: "About {{person.preferred_name}}" }, []],
    [
      "an NHS number in a letter",
      { channel: "letter", subject: null, body: "Ref {{person.nhs_number}}" },
      [],
    ],
  ])("%s", (_label, o, problems) => {
    expect(check(o)).toEqual(problems);
  });
});

describe("hazard HZ-051 duty of candour letters", () => {
  const candourLetter = version({
    kind: "duty_of_candour",
    channel: "letter",
    subject: null,
    body: "Dear {{recipient.full_name}},\n\n{{candour.account}}\n\n{{candour.enquiries}}\n\n{{candour.results}}\n\n{{candour.apology}}",
  });
  const serviceUser: CandourRelevantPerson = { kind: "service_user", personId: ADA };
  const daughter: CandourRelevantPerson = {
    kind: "representative",
    personId: ADA,
    contactId: "contact-daughter",
    basis: "lacks_capacity",
  };
  function candourValues(
    results: MergeValue["value"],
    o: Partial<TemplateRenderRequest> = {},
  ): TemplateRenderRequest {
    return {
      subjectPersonId: ADA,
      values: {
        "recipient.full_name": { value: "Ada Example", personId: ADA },
        "candour.account": { value: "Ada fell at 07:30 and broke her hip.", personId: ADA },
        "candour.enquiries": { value: "We are reviewing the night checks.", personId: ADA },
        "candour.results": { value: results, personId: ADA },
        "candour.apology": { value: "We are sorry this happened.", personId: ADA },
      },
      candour: { relevantPerson: serviceUser, recipient: { kind: "person", personId: ADA } },
      ...o,
    };
  }

  it("lets the first written notification say the results will follow, with the date", () => {
    const result = renderTemplate(
      candourLetter,
      candourValues({ kind: "results_to_follow", expectedBy: "2026-11-30" }),
    );
    expect(result.ok && result.rendered.resultsToFollow).toBe(true);
    expect(result.ok && result.rendered.text).toContain(
      "The results of our further enquiries are not available yet. We will write to you with them by 30/11/2026.",
    );
  });

  it("says the results will follow as soon as they are available when no date is known", () => {
    expect(resultsToFollowText({ kind: "results_to_follow", expectedBy: null })).toBe(
      "The results of our further enquiries are not available yet. We will write to you with them as soon as they are.",
    );
    expect(resultsToFollowText({ kind: "results_to_follow", expectedBy: "2026-02-30" })).toBeNull();
  });

  it("marks a letter with the results as complete", () => {
    const result = renderTemplate(candourLetter, candourValues("No further failings were found."));
    expect(result.ok && result.rendered.resultsToFollow).toBe(false);
  });

  it("refuses 'results to follow' in any other field", () => {
    const base = candourValues("Found.");
    const result = renderTemplate(candourLetter, {
      ...base,
      values: {
        ...base.values,
        "candour.apology": {
          value: { kind: "results_to_follow", expectedBy: null },
          personId: ADA,
        },
      },
    });
    expect(result.ok ? null : result.problems.map((p) => [p.problem, p.fields])).toEqual([
      ["wrong_type", ["candour.apology"]],
    ]);
  });

  it.each<[string, Partial<TemplateRenderRequest>, string | null]>([
    ["to the person themself", {}, null],
    [
      "to a representative the candour record names",
      {
        candour: {
          relevantPerson: daughter,
          recipient: { kind: "contact", personId: ADA, contactId: "contact-daughter" },
        },
      },
      null,
    ],
    ["with no relevant person", { candour: null }, "candour_recipient_required"],
    [
      "to a different contact",
      {
        candour: {
          relevantPerson: daughter,
          recipient: { kind: "contact", personId: ADA, contactId: "contact-son" },
        },
      },
      "candour_wrong_recipient",
    ],
    [
      "to a contact when the relevant person is the person themself",
      {
        candour: {
          relevantPerson: serviceUser,
          recipient: { kind: "contact", personId: ADA, contactId: "contact-daughter" },
        },
      },
      "candour_wrong_recipient",
    ],
    [
      "about another person's candour record",
      {
        candour: {
          relevantPerson: { kind: "service_user", personId: BEN },
          recipient: { kind: "person", personId: BEN } satisfies LetterRecipient,
        },
      },
      "candour_wrong_recipient",
    ],
  ])("hazard HZ-051 sends a candour letter %s", (_label, o, problem) => {
    const result = renderTemplate(candourLetter, candourValues("Found.", o));
    expect(result.ok ? null : result.problems.map((p) => p.problem)).toEqual(
      problem === null ? null : [problem],
    );
  });

  const facts = (died: boolean, under16NotCompetent: boolean, lacksCapacityForMatter: boolean) => ({
    died,
    under16NotCompetent,
    lacksCapacityForMatter,
  });

  it.each<[string, CandourRelevantPerson, ReturnType<typeof facts>, string[]]>([
    ["the person, who has capacity", serviceUser, facts(false, false, false), []],
    [
      "the person, who has died",
      serviceUser,
      facts(true, false, false),
      ["representative_required"],
    ],
    [
      "the person, who lacks capacity for the matter",
      serviceUser,
      facts(false, false, true),
      ["representative_required"],
    ],
    ["a representative, the person lacking capacity", daughter, facts(false, false, true), []],
    [
      "a representative, the person having capacity",
      daughter,
      facts(false, false, false),
      ["representative_basis_not_met"],
    ],
    [
      "a representative after a death",
      { ...daughter, basis: "death" },
      facts(true, false, false),
      [],
    ],
    [
      "a representative for a child under 16 who is not competent",
      { ...daughter, basis: "under_16_not_competent" },
      facts(false, true, false),
      [],
    ],
  ])("regulation 20(7): %s", (_label, relevantPerson, circumstances, problems) => {
    expect(checkCandourRelevantPerson(relevantPerson, circumstances)).toEqual(problems);
  });
});

describe("letter retention follows the incident's grade", () => {
  it.each<[Parameters<typeof letterRetentionClass>[0], string]>([
    [{ kind: "duty_of_candour", incidentSerious: true }, "serious_incident"],
    [{ kind: "incident_follow_up", incidentSerious: true }, "serious_incident"],
    [{ kind: "incident_follow_up", incidentSerious: false }, "care_record"],
    [{ kind: "duty_of_candour", incidentSerious: null }, "care_record"],
    [{ kind: "fee_review", incidentSerious: null }, "care_record"],
  ])("%o is kept as %s", (letter, retentionClass) => {
    expect(letterRetentionClass(letter)).toBe(retentionClass);
  });
});
