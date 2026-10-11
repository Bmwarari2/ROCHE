import { describe, expect, it } from "vitest";
import {
  ABOUT_ME_SECTIONS,
  type AboutMeDocument,
  aboutMeFilledSections,
  summariseAboutMe,
  validateAboutMe,
} from "./about-me";

const example: AboutMeDocument = {
  what_is_most_important_to_me: {
    text: "Seeing my granddaughter on Sundays.",
    media: [{ documentId: "doc-1", mimeType: "audio/mp4", filename: "sundays.m4a" }],
  },
  how_i_communicate: { text: "Speak slowly, on my left side." },
  my_wellness: { text: "   " },
  supported_to_write_this_by: "Ada Example, daughter, ada@example.invalid",
  date_last_updated: "2026-10-11T09:30:00Z",
};

describe("About Me sections (PRSB v2.01)", () => {
  it("has the seven PRSB sections with their SNOMED CT headings, as data-standards.md maps them", () => {
    expect(ABOUT_ME_SECTIONS.map((s) => [s.key, s.snomedHeading])).toEqual([
      ["what_is_most_important_to_me", "1515861000000103"],
      ["people_who_are_important_to_me", "1515871000000105"],
      ["how_i_communicate", "1515881000000107"],
      ["my_wellness", "1515891000000109"],
      ["please_do_and_please_do_not", "1515901000000105"],
      ["how_and_when_to_support_me", "1515911000000107"],
      ["also_worth_knowing_about_me", "1515921000000101"],
    ]);
  });

  it("counts a section as filled only when it has words or media", () => {
    expect(aboutMeFilledSections(example)).toEqual([
      "what_is_most_important_to_me",
      "how_i_communicate",
    ]);
    expect(aboutMeFilledSections({ my_wellness: null })).toEqual([]);
  });
});

describe("About Me validation", () => {
  it("accepts the documented example", () => {
    expect(validateAboutMe(example, { authoredByPerson: false })).toEqual([]);
  });

  it("accepts an empty document written by the person", () => {
    expect(validateAboutMe({}, { authoredByPerson: true })).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, boolean, readonly unknown[]]>([
    [
      "a section PRSB does not have",
      { favourite_colour: { text: "Green" } },
      true,
      [{ kind: "unknown_section", key: "favourite_colour" }],
    ],
    [
      "media without a document",
      { my_wellness: { media: [{ documentId: "", mimeType: "image/png" }] } },
      true,
      [{ kind: "inline_media", section: "my_wellness" }],
    ],
    [
      "help without naming who helped",
      { my_wellness: { text: "I walk every day." } },
      false,
      [{ kind: "supporter_required" }],
    ],
    [
      "an unreadable update time",
      { date_last_updated: "yesterday" },
      true,
      [{ kind: "invalid_update_time" }],
    ],
  ])("flags %s", (_label, document, authoredByPerson, issues) => {
    expect(validateAboutMe(document, { authoredByPerson })).toEqual(issues);
  });
});

describe("About Me summary", () => {
  it("summarises what is filled and when it was updated", () => {
    expect(summariseAboutMe(example)).toEqual({
      filled: ["what_is_most_important_to_me", "how_i_communicate"],
      missing: [
        "people_who_are_important_to_me",
        "my_wellness",
        "please_do_and_please_do_not",
        "how_and_when_to_support_me",
        "also_worth_knowing_about_me",
      ],
      dateLastUpdated: new Date("2026-10-11T09:30:00Z"),
      hasContent: true,
    });
  });

  it("treats a missing document as having no content", () => {
    expect(summariseAboutMe(null)).toMatchObject({ hasContent: false, dateLastUpdated: null });
    expect(summariseAboutMe({ date_last_updated: "nonsense" }).dateLastUpdated).toBeNull();
  });
});
