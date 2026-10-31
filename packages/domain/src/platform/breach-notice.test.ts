import { describe, expect, it } from "vitest";
import { NOTICE_PROMPT, noticeHasPrompts, subjectNoticeDraft } from "./breach-notice";

describe("PLAT-022 the notice to the people affected by a breach", () => {
  const base = {
    summary: "A letter about your care went to the wrong address.",
    organisation: "Harbour Demo Care",
    contactName: "Dee Protection",
    contactEmail: "dpo@example.invalid",
  };

  it("fills the template in the order the ICO asks for, with prompts for a person", () => {
    const notice = subjectNoticeDraft(base);
    const headings = [
      "What happened",
      "What this means for you",
      "What we have done",
      "What you can do",
      "Who to contact",
    ];
    const at = headings.map((h) => notice.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(notice).toContain(base.summary);
    expect(notice).toContain("Dee Protection, dpo@example.invalid");
    expect(notice).toContain("Information Commissioner's Office");
    expect(noticeHasPrompts(notice)).toBe(true);
  });

  it.each([
    [{ contactName: null, contactEmail: "dpo@example.invalid" }, "contact dpo@example.invalid."],
    [{ contactName: "Dee Protection", contactEmail: null }, "contact Dee Protection."],
    [{ contactName: null, contactEmail: null }, `contact ${NOTICE_PROMPT}who to contact`],
  ])("names whoever is recorded to contact (%o)", (contact, words) => {
    expect(subjectNoticeDraft({ ...base, ...contact })).toContain(words);
  });

  it("is ready to send only once every prompt is replaced", () => {
    expect(noticeHasPrompts("What happened\n\nA letter went astray. Contact us.")).toBe(false);
    expect(noticeHasPrompts(`Text ${NOTICE_PROMPT}something.]`)).toBe(true);
  });
});
