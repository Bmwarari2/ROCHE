import { describe, expect, it } from "vitest";
import {
  FEED_CLINICAL_TERM_KINDS,
  FEED_CLINICAL_TERMS,
  FEED_READABILITY_LINT,
  feedLetterCount,
  feedReadabilityLint,
  feedSentences,
  feedWords,
  findClinicalTerms,
  findNameMentions,
  hasEmailLikeText,
  longestDigitRun,
} from "./feed-text";

/**
 * Text checks for family surfaces (comms.md section 4 rules 9 to 11). Invented people only: Ada
 * Example, her son Ben, staff member Sam Tester, residents Dev Sample and Rose Fixture.
 */

describe("words and sentences", () => {
  it.each<[string, string, readonly string[]]>([
    ["plain words", "Ada joined the quiz", ["Ada", "joined", "the", "quiz"]],
    ["a possessive", "Ada's daughter", ["Ada's", "daughter"]],
    ["a curly apostrophe", "Ada’s garden", ["Ada’s", "garden"]],
    ["a hyphenated word", "well-being", ["well-being"]],
    ["quotes and dashes around words", "'quiz' - then -tea-", ["quiz", "then", "tea"]],
    ["punctuation between words", "Rose, rose.", ["Rose", "rose"]],
    [
      "digits",
      "Room 12 at 2.30, then 1,000 steps",
      ["Room", "12", "at", "2.30", "then", "1,000", "steps"],
    ],
    ["accented letters", "Zoë sang", ["Zoë", "sang"]],
    ["nothing", "   ", []],
  ])("splits %s", (_label, text, words) => {
    expect(feedWords(text).map((t) => t.text)).toEqual(words);
  });

  it("keeps the offsets of each word", () => {
    const [first, second] = feedWords("  Ada sang");
    expect(first).toEqual({ text: "Ada", start: 2, end: 5 });
    expect(second).toEqual({ text: "sang", start: 6, end: 10 });
  });

  it.each<[string, string, readonly number[]]>([
    ["two sentences", "Ada joined the quiz. She won!", [4, 2]],
    ["a question", "Did Ada enjoy it? Yes.", [4, 1]],
    ["a decimal number", "It cost 2.5 pounds.", [4]],
    ["a line break", "Garden club\nTea after", [2, 2]],
    ["repeated stops", "Lovely... Then tea.", [1, 2]],
    ["no stop at the end", "Ada sang", [2]],
    ["only punctuation", "...", []],
  ])("counts the words in %s", (_label, text, counts) => {
    expect(feedSentences(text).map((s) => s.length)).toEqual(counts);
  });

  it("counts letters only", () => {
    expect(feedLetterCount("well-being")).toBe(9);
    expect(feedLetterCount("Ada's")).toBe(4);
    expect(feedLetterCount("12")).toBe(0);
  });
});

describe("reading age lint (advice, never a gate)", () => {
  const words = (n: number) => Array.from({ length: n }, () => "tea").join(" ");

  it("finds nothing in short, plain sentences", () => {
    expect(feedReadabilityLint("Ada joined the quiz. She sang two songs.")).toEqual([]);
  });

  it("allows a sentence of exactly the limit and flags one more", () => {
    const limit = FEED_READABILITY_LINT.maxWordsPerSentence;
    expect(feedReadabilityLint(`${words(limit)}.`)).toEqual([]);
    expect(feedReadabilityLint(`Short one. ${words(limit + 1)}.`)).toEqual([
      {
        kind: "long_sentence",
        sentence: 2,
        words: limit + 1,
        limit,
        message: `Sentence 2 has ${limit + 1} words. Try ${limit} or fewer.`,
      },
    ]);
  });

  it("flags a long word once, however often it appears", () => {
    const limit = FEED_READABILITY_LINT.maxLettersPerWord;
    const atLimit = "a".repeat(limit);
    const over = "Physiotherapist";
    expect(feedReadabilityLint(`${atLimit} came.`)).toEqual([]);
    const findings = feedReadabilityLint(`The ${over} came. The physiotherapist left.`);
    expect(findings).toEqual([
      {
        kind: "long_word",
        word: over,
        letters: over.length,
        limit,
        message: `"${over}" is a long word. Try a shorter one.`,
      },
    ]);
  });

  it("takes other limits when the content designer tunes them", () => {
    expect(
      feedReadabilityLint("Ada sang today.", { maxWordsPerSentence: 2, maxLettersPerWord: 3 }).map(
        (f) => f.kind,
      ),
    ).toEqual(["long_sentence", "long_word", "long_word"]);
  });
});

describe("clinical vocabulary (medical-device boundary backstop)", () => {
  it.each<[string, string, readonly [string, string][]]>([
    [
      "a NEWS2 score",
      "Her NEWS2 score was 3 today.",
      [
        ["NEWS2", "validated_tool_or_score"],
        ["score", "validated_tool_or_score"],
      ],
    ],
    ["NEWS in capitals", "NEWS was 5", [["NEWS", "validated_tool_or_score"]]],
    ["MUST in capitals", "Her MUST was high", [["MUST", "validated_tool_or_score"]]],
    [
      "Waterlow and Braden",
      "waterlow and Braden done",
      [
        ["waterlow", "validated_tool_or_score"],
        ["Braden", "validated_tool_or_score"],
      ],
    ],
    [
      "a diagnosis",
      "The GP diagnosed a chest infection.",
      [
        ["diagnosed", "diagnosis_or_condition"],
        ["infection", "diagnosis_or_condition"],
      ],
    ],
    ["a UTI", "Possible UTI", [["UTI", "diagnosis_or_condition"]]],
    ["a prognosis", "Ada is nearing the end of life.", [["end of life", "prognosis"]]],
    ["deterioration", "She is deteriorating", [["deteriorating", "prognosis"]]],
    [
      "a measurement",
      "Her blood pressure was normal.",
      [["blood pressure", "clinical_measurement"]],
    ],
    ["oxygen", "On oxygen overnight", [["oxygen", "clinical_measurement"]]],
    [
      "medicines",
      "She had her antibiotics and medication.",
      [
        ["antibiotics", "medicine"],
        ["medication", "medicine"],
      ],
    ],
    ["a pressure ulcer", "A pressure ulcer on her heel", [["ulcer", "diagnosis_or_condition"]]],
  ])("finds %s", (_label, text, expected) => {
    expect(findClinicalTerms(text).map((m) => [m.found, m.kind])).toEqual(expected);
  });

  it.each([
    ["the news, in lower case", "Ada read the news with Ben."],
    ["must, in lower case", "Ben said you must come for tea."],
    ["blood orange cake", "Ada enjoyed the blood orange cake."],
    ["an everyday day", "Ada joined the garden club and planted bulbs."],
    ["a tablet computer", "Ada called Ben on the tablet."],
  ])("finds nothing in %s", (_label, text) => {
    expect(findClinicalTerms(text)).toEqual([]);
  });

  it("accepts that a backstop sometimes catches an innocent word", () => {
    // "scored" in a quiz is refused too; the writer says "won" instead.
    expect(findClinicalTerms("Ada scored a point in the quiz.").map((m) => m.found)).toEqual([
      "scored",
    ]);
  });

  it("uses only known kinds, lower-case words unless case-sensitive, and prefixes of one word", () => {
    for (const entry of FEED_CLINICAL_TERMS) {
      expect(FEED_CLINICAL_TERM_KINDS).toContain(entry.kind);
      expect(entry.words.length).toBeGreaterThan(0);
      if (!entry.caseSensitive) {
        for (const w of entry.words) expect(w).toBe(w.toLowerCase());
      }
      if (entry.prefix) expect(entry.words).toHaveLength(1);
    }
  });

  it("covers the three validated tools the boundary names", () => {
    for (const tool of ["NEWS2", "MUST", "Waterlow"]) {
      expect(findClinicalTerms(`The ${tool} result`)).not.toEqual([]);
    }
  });
});

describe("names, contact details and long numbers", () => {
  it("matches names case-sensitively, word by word", () => {
    expect(findNameMentions("Rose picked a rose for Rose.", "Rose").map((m) => m.found)).toEqual([
      "Rose",
      "Rose",
    ]);
    expect(findNameMentions("Dev Sample and Devon", "Dev Sample").map((m) => m.found)).toEqual([
      "Dev Sample",
    ]);
    expect(findNameMentions("Samples of cake", "Sample")).toEqual([]);
  });

  it("allows a possessive on the last word of a name", () => {
    expect(findNameMentions("Sam Tester's guitar", "Sam Tester")).toEqual([
      { start: 0, end: 12, found: "Sam Tester's", possessive: "'s" },
    ]);
    expect(findNameMentions("Sam's guitar", "Sam")[0]?.possessive).toBe("'s");
    expect(findNameMentions("Sam's Tester", "Sam Tester")).toEqual([]);
  });

  it("matches names of several words and ignores an empty name", () => {
    expect(findNameMentions("with Anna de Souza today", "de Souza")).toHaveLength(1);
    expect(findNameMentions("anything", "  ")).toEqual([]);
  });

  it.each([
    ["an email address", "Write to ben@example.invalid", true],
    ["a lone at sign", "Tea @ 3", false],
    ["an at sign at the start", "@home", false],
    ["no at sign", "Ada had tea", false],
  ])("spots %s", (_label, text, expected) => {
    expect(hasEmailLikeText(text)).toBe(expected);
  });

  it.each<[string, string, number]>([
    ["an NHS number with spaces", "Her number is 999 123 4567", 10],
    ["a mobile number", "Call 07700 900123", 11],
    ["a room and a time", "Room 12, 3 o'clock", 2],
    ["hyphenated digits", "1-2-3", 3],
    ["a trailing separator", "12 - tea", 2],
    ["no digits", "tea", 0],
  ])("measures the longest digit run in %s", (_label, text, run) => {
    expect(longestDigitRun(text)).toBe(run);
  });
});
