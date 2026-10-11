import { describe, expect, it } from "vitest";
import {
  FEED_EVENT_TERMS,
  FEED_WELLBEING_TERMS,
  findClinicalTerms,
  findConfirmationTerms,
  findFeedTerms,
  findNameMentions,
  foldLookalikes,
  hasEmailLikeText,
  longestDigitRun,
  normaliseFeedText,
} from "./feed-text";

/**
 * Text checks added after the clinical and security review (comms.md section 4 rules 9 to 11):
 * hidden characters, lookalike letters, hyphenated and plural clinical words, and the event and
 * wellbeing words that need a manager's confirmation. Invented people: Robert Sample, known as Bob.
 */

describe("text is normalised before any check", () => {
  it.each<[string, string, string]>([
    ["a zero-width space", "Sam​ple", "Sample"],
    ["a soft hyphen", "Sam­ple", "Sample"],
    ["a zero-width joiner and a direction mark", "Sa‍m‎ple", "Sample"],
    ["a bidirectional override", "‮Sample‬", "Sample"],
    ["full-width letters and an at sign", "Ａda＠home", "Ada@home"],
    ["plain text", "Ada sang.", "Ada sang."],
  ])("removes or folds %s", (_label, text, expected) => {
    expect(normaliseFeedText(text)).toBe(expected);
  });

  it("folds Cyrillic and Greek lookalike letters without changing the length", () => {
    const disguised = "Rоbert СΟVID";
    expect(foldLookalikes(disguised)).toBe("Robert COVID");
    expect(foldLookalikes(disguised)).toHaveLength(disguised.length);
  });
});

describe("hazard HZ-022 clinical words hidden by hyphens, plurals, case or lookalikes", () => {
  it.each<[string, string, readonly string[]]>([
    ["COVID-19", "Ada had COVID-19 last year.", ["COVID"]],
    ["anti-depressants", "She is on anti-depressants.", ["depressants"]],
    ["pre-diabetic", "Ada is pre-diabetic.", ["diabetic"]],
    ["UTIs", "She keeps getting UTIs.", ["UTIs"]],
    ["pressure sores", "She has pressure sores.", ["pressure sores"]],
    ["end-of-life", "Her end-of-life wishes were discussed.", ["end-of-life"]],
    ["COVID in Cyrillic and Greek letters", "СΟVID on the unit", ["СΟVID"]],
    ["the MUST score in mixed case", "Her Must score went up.", ["Must score", "score"]],
  ])("finds %s", (_label, text, found) => {
    expect(findClinicalTerms(text).map((m) => m.found)).toEqual(found);
  });

  it("leaves 'Must' at the start of an ordinary sentence alone (the trade-off in comms.md)", () => {
    expect(findClinicalTerms("Must remember the garden club on Friday.")).toEqual([]);
  });
});

describe("hazards HZ-060 and HZ-061 events and wellbeing claims need a manager's confirmation", () => {
  it.each<[string, string, readonly string[]]>([
    ["a fall", "Ada had a fall this morning.", ["fall"]],
    ["a fall in the past tense", "Ada fell in the lounge.", ["fell"]],
    ["an A&E visit", "Ada went to A&E last night.", ["A&E"]],
    ["an ambulance", "We called an ambulance for Ada.", ["ambulance"]],
    ["999", "Staff called 999.", ["999"]],
    ["a hospital stay", "Ada is back from hospital.", ["hospital"]],
    ["a death", "Ada died peacefully.", ["died"]],
    ["passing away", "Ada passed away this morning.", ["passed away"]],
    ["a stroke", "Ada had a stroke.", ["stroke"]],
    ["an injury", "Ada injured her arm.", ["injured"]],
    ["safeguarding", "A safeguarding concern was raised.", ["safeguarding"]],
    ["the police", "The police came to the home.", ["police"]],
    ["a missing person", "Ada went missing for an hour.", ["missing"]],
    ["the GP", "The GP came to see Ada.", ["GP"]],
    ["settled and happy", "Ada is settled and happy.", ["settled", "happy"]],
    ["fine", "Ada was fine all day.", ["was fine"]],
    ["well in herself", "Ada seems well in herself.", ["seems well", "well in herself"]],
    ["comfortable", "Ada was comfortable overnight.", ["comfortable"]],
    ["no concerns", "No concerns today.", ["No concerns"]],
  ])("flags %s", (_label, text, found) => {
    expect(findConfirmationTerms(text).map((m) => m.found)).toEqual(found);
  });

  it.each([
    ["falling asleep", "Ada fell asleep during the film."],
    ["a happy birthday", "We sang happy birthday to Ada."],
    ["the hospitality team", "The hospitality team made a cake."],
    ["a stroked cat", "Ada stroked the cat."],
    ["an NHS number", "Her number is 999 123 4567."],
    ["an everyday day", "Ada joined the garden club and planted bulbs."],
  ])("does not flag %s", (_label, text) => {
    expect(findConfirmationTerms(text)).toEqual([]);
  });

  it("keeps every event and wellbeing term to lower-case words unless case-sensitive", () => {
    for (const entry of [...FEED_EVENT_TERMS, ...FEED_WELLBEING_TERMS]) {
      if (!entry.caseSensitive) for (const w of entry.words) expect(w).toBe(w.toLowerCase());
      if (entry.prefix) expect(entry.words).toHaveLength(1);
    }
    expect(findFeedTerms("Ada was settled.", FEED_WELLBEING_TERMS)).toEqual([
      { found: "settled", kind: "wellbeing_claim" },
    ]);
  });
});

describe("hazard HZ-022 names in any case, with hidden characters or lookalike letters", () => {
  const prepared = (text: string) => normaliseFeedText(text);

  it.each<[string, string, string, boolean, readonly string[]]>([
    ["lower case", "Ada sat with robert sample.", "Robert Sample", true, ["robert sample"]],
    ["capitals", "Ada sat with ROBERT SAMPLE.", "Robert Sample", true, ["ROBERT SAMPLE"]],
    ["a Cyrillic o", "Ada sat with Rоbert.", "Robert", false, ["Rоbert"]],
    ["a zero-width space", "Ada sat with Mr Sam​ple.", "Sample", true, ["Sample"]],
    ["a known-as name", "Ada sat with Bob.", "Bob", false, ["Bob"]],
  ])("finds a name in %s", (_label, text, name, ignoreCase, found) => {
    expect(findNameMentions(prepared(text), name, { ignoreCase }).map((m) => m.found)).toEqual(
      found,
    );
  });

  it("still tells a capitalised first name from an ordinary word by default", () => {
    expect(findNameMentions("Ada picked a rose.", "Rose")).toEqual([]);
  });
});

describe("contact details and long numbers however they are written", () => {
  it.each<[string, string, number]>([
    ["a bracketed area code", "Ring (01632) 960 001 please", 11],
    ["points between groups", "Her number is 999.123.4567", 10],
    ["full-width digits", "０７７００ 900123", 11],
    ["a time after a date", "On 11/10/2026 10:30 she sang", 6],
    ["separate small numbers", "Rooms 12 and 14", 2],
  ])("measures %s", (_label, text, run) => {
    expect(longestDigitRun(text)).toBe(run);
  });

  it("spots a full-width at sign", () => {
    expect(hasEmailLikeText("ben＠example.invalid")).toBe(true);
  });
});
