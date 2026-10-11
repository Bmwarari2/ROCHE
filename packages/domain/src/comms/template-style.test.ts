import { describe, expect, it } from "vitest";
import { MAX_SENTENCE_WORDS, templateStyleWarnings } from "./template-style";

/** Optional plain-English hints (comms.md rule 9): advisory, never blocking. */

describe("template style hints", () => {
  const long = Array.from({ length: MAX_SENTENCE_WORDS + 1 }, (_, i) => `word${i}`).join(" ");

  it.each<[string, { name: string; body: string }, string[]]>([
    [
      "a plain letter",
      { name: "Fee review letter", body: "Dear {{recipient.full_name}},\n\nThank you." },
      [],
    ],
    ["a long sentence", { name: "Letter", body: `${long}.` }, ["long_sentence"]],
    [
      "a sentence of exactly the limit",
      { name: "Letter", body: `${long.split(" ").slice(1).join(" ")}.` },
      [],
    ],
    [
      "capitals for emphasis, once per word",
      { name: "Letter", body: "Please NEVER park here. NEVER ever." },
      ["capitals"],
    ],
    ["three-letter capitals", { name: "Letter", body: "Do NOT park here." }, []],
    ["acronyms", { name: "Letter", body: "The CQC and the NHS. A DNACPR form." }, []],
    ["short capitals", { name: "Letter", body: "We are OK." }, []],
    ["merge fields", { name: "Letter", body: "{{PERSON.NAME}}" }, []],
    [
      "a title-case name",
      { name: "Welcome To Harbour House", body: "Hello." },
      ["title_case_name"],
    ],
    ["a sentence-case name", { name: "Welcome to Harbour House", body: "Hello." }, []],
    [
      "paragraph breaks end sentences",
      {
        name: "Letter",
        body: `${long.split(" ").slice(0, 20).join(" ")}\n\n${long.split(" ").slice(0, 20).join(" ")}`,
      },
      [],
    ],
  ])("%s", (_label, input, kinds) => {
    expect(templateStyleWarnings(input).map((w) => w.kind)).toEqual(kinds);
  });

  it("says how long the sentence is", () => {
    expect(templateStyleWarnings({ name: "Letter", body: long })[0]?.message).toBe(
      `This sentence has ${MAX_SENTENCE_WORDS + 1} words. Try to keep sentences to ${MAX_SENTENCE_WORDS} or fewer.`,
    );
  });
});
