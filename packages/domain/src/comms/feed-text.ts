/**
 * Text checks for everything a family member reads in the feed or in a notification (comms.md
 * section 4 rules 9 to 11 and 13; master prompt 8 "plain English at reading age 9 for family and
 * resident surfaces"; 5.2 and the medical-device boundary: no score, diagnosis or prognosis).
 *
 * Every check walks the text with plain loops over code points. No regular expression with an
 * unbounded repeat ever runs over user text (the CodeQL polynomial ReDoS gate); the only pattern
 * here tests a single character.
 */

export interface FeedTextToken {
  /** The word as written. */
  readonly text: string;
  /** Code-unit offsets in the original text, end exclusive. */
  readonly start: number;
  readonly end: number;
}

const WORD_CHARACTER = /^[\p{L}\p{N}]$/u;
const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;
const JOINERS = new Set(["'", "’", "-"]);
const NUMBER_JOINERS = new Set([".", ","]);
const SENTENCE_ENDS = new Set([".", "!", "?"]);

function codePoints(text: string): { ch: string; at: number }[] {
  const out: { ch: string; at: number }[] = [];
  let at = 0;
  for (const ch of text) {
    out.push({ ch, at });
    at += ch.length;
  }
  return out;
}

const isWordCharacter = (ch: string | undefined): boolean =>
  ch !== undefined && WORD_CHARACTER.test(ch);

const isDigit = (ch: string | undefined): boolean => ch !== undefined && DIGIT.test(ch);

/**
 * Words in order. Letters and digits make a word; an apostrophe or hyphen joins two parts of one
 * word ("Ada's", "well-being") only when a letter or digit sits on both sides, and a point or
 * comma joins digits ("2.30", "1,000").
 */
export function feedWords(text: string): FeedTextToken[] {
  const chars = codePoints(text);
  const tokens: FeedTextToken[] = [];
  let start = -1;
  for (let i = 0; i < chars.length; i++) {
    const current = chars[i] as { ch: string; at: number };
    const before = chars[i - 1]?.ch;
    const after = chars[i + 1]?.ch;
    const joins =
      start >= 0 &&
      ((JOINERS.has(current.ch) && isWordCharacter(before) && isWordCharacter(after)) ||
        (NUMBER_JOINERS.has(current.ch) && isDigit(before) && isDigit(after)));
    if (isWordCharacter(current.ch) || joins) {
      if (start < 0) start = current.at;
      continue;
    }
    if (start >= 0) {
      tokens.push({ text: text.slice(start, current.at), start, end: current.at });
      start = -1;
    }
  }
  if (start >= 0) tokens.push({ text: text.slice(start), start, end: text.length });
  return tokens;
}

/**
 * Sentences as lists of words. A sentence ends at a full stop, question mark or exclamation mark
 * that is not between two digits ("2.5"), or at a line break.
 */
export function feedSentences(text: string): FeedTextToken[][] {
  const chars = codePoints(text);
  const boundaries: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const { ch, at } = chars[i] as { ch: string; at: number };
    if (ch === "\n" || ch === "\r") {
      boundaries.push(at);
      continue;
    }
    if (!SENTENCE_ENDS.has(ch)) continue;
    const before = chars[i - 1]?.ch;
    const after = chars[i + 1]?.ch;
    const decimal = ch === "." && before !== undefined && after !== undefined;
    if (decimal && DIGIT.test(before) && DIGIT.test(after)) continue;
    boundaries.push(at);
  }
  const sentences: FeedTextToken[][] = [];
  let current: FeedTextToken[] = [];
  let next = 0;
  for (const token of feedWords(text)) {
    while (next < boundaries.length && (boundaries[next] as number) < token.start) {
      if (current.length > 0) sentences.push(current);
      current = [];
      next++;
    }
    current.push(token);
  }
  if (current.length > 0) sentences.push(current);
  return sentences;
}

export function feedLetterCount(word: string): number {
  let count = 0;
  for (const ch of word) if (LETTER.test(ch)) count++;
  return count;
}

// ------------------------------------------------------------------------------------------------
// Reading age lint (a lint for the writer, never a gate)
// ------------------------------------------------------------------------------------------------

/**
 * Harbour's plain-English lint for family surfaces. These are writing-style defaults for staff, not
 * statutory or clinical figures, and not a readability score: the lint names long sentences and
 * long words so the writer can shorten them. The content designer may tune them (comms.md section
 * 10).
 */
export const FEED_READABILITY_LINT = {
  maxWordsPerSentence: 15,
  maxLettersPerWord: 12,
} as const;

export type FeedReadabilityFinding =
  | {
      readonly kind: "long_sentence";
      /** 1-based position of the sentence. */
      readonly sentence: number;
      readonly words: number;
      readonly limit: number;
      readonly message: string;
    }
  | {
      readonly kind: "long_word";
      readonly word: string;
      readonly letters: number;
      readonly limit: number;
      readonly message: string;
    };

/** Long sentences and long words, so the writer can aim for a reading age of about 9. */
export function feedReadabilityLint(
  text: string,
  limits: {
    readonly maxWordsPerSentence: number;
    readonly maxLettersPerWord: number;
  } = FEED_READABILITY_LINT,
): FeedReadabilityFinding[] {
  const findings: FeedReadabilityFinding[] = [];
  feedSentences(text).forEach((sentence, index) => {
    if (sentence.length > limits.maxWordsPerSentence) {
      findings.push({
        kind: "long_sentence",
        sentence: index + 1,
        words: sentence.length,
        limit: limits.maxWordsPerSentence,
        message: `Sentence ${index + 1} has ${sentence.length} words. Try ${limits.maxWordsPerSentence} or fewer.`,
      });
    }
  });
  const seen = new Set<string>();
  for (const token of feedWords(text)) {
    const letters = feedLetterCount(token.text);
    const key = token.text.toLowerCase();
    if (letters > limits.maxLettersPerWord && !seen.has(key)) {
      seen.add(key);
      findings.push({
        kind: "long_word",
        word: token.text,
        letters,
        limit: limits.maxLettersPerWord,
        message: `"${token.text}" is a long word. Try a shorter one.`,
      });
    }
  }
  return findings;
}

// ------------------------------------------------------------------------------------------------
// Clinical vocabulary (medical-device boundary backstop)
// ------------------------------------------------------------------------------------------------

export const FEED_CLINICAL_TERM_KINDS = [
  "validated_tool_or_score",
  "diagnosis_or_condition",
  "prognosis",
  "clinical_measurement",
  "medicine",
] as const;
export type FeedClinicalTermKind = (typeof FEED_CLINICAL_TERM_KINDS)[number];

export interface FeedClinicalTerm {
  /** Lower-case words in order, unless `caseSensitive`. */
  readonly words: readonly string[];
  readonly kind: FeedClinicalTermKind;
  /** A one-word term that also matches words starting with it ("diagnos" matches "diagnosed"). */
  readonly prefix?: boolean;
  /** For terms that are ordinary words in lower case ("MUST", "NEWS"). */
  readonly caseSensitive?: boolean;
}

const term = (
  kind: FeedClinicalTermKind,
  words: string,
  options: { prefix?: boolean; caseSensitive?: boolean } = {},
): FeedClinicalTerm => ({ kind, words: words.split(" "), ...options });

/**
 * Words that make a family update read as a score, a diagnosis or a prognosis, or that carry
 * clinical measurements or medicines. A backstop behind the staff member's decision to share a
 * note: it is not complete, and a match refuses the text so the writer can say it another way.
 * The validated tools are the ones in the medical-device boundary (section 5).
 */
export const FEED_CLINICAL_TERMS: readonly FeedClinicalTerm[] = [
  term("validated_tool_or_score", "news2"),
  term("validated_tool_or_score", "NEWS", { caseSensitive: true }),
  term("validated_tool_or_score", "MUST", { caseSensitive: true }),
  term("validated_tool_or_score", "waterlow"),
  term("validated_tool_or_score", "braden"),
  term("validated_tool_or_score", "painad"),
  term("validated_tool_or_score", "barthel"),
  term("validated_tool_or_score", "abbey pain"),
  term("validated_tool_or_score", "cornell scale"),
  term("validated_tool_or_score", "ohat"),
  term("validated_tool_or_score", "gcs"),
  term("validated_tool_or_score", "glasgow coma"),
  term("validated_tool_or_score", "score", { prefix: true }),
  term("diagnosis_or_condition", "diagnos", { prefix: true }),
  term("diagnosis_or_condition", "infect", { prefix: true }),
  term("diagnosis_or_condition", "sepsis"),
  term("diagnosis_or_condition", "uti"),
  term("diagnosis_or_condition", "pneumonia"),
  term("diagnosis_or_condition", "covid"),
  term("diagnosis_or_condition", "norovirus"),
  term("diagnosis_or_condition", "influenza"),
  term("diagnosis_or_condition", "dementia"),
  term("diagnosis_or_condition", "delirium"),
  term("diagnosis_or_condition", "fractur", { prefix: true }),
  term("diagnosis_or_condition", "ulcer", { prefix: true }),
  term("diagnosis_or_condition", "pressure sore"),
  term("diagnosis_or_condition", "pressure damage"),
  term("diagnosis_or_condition", "dehydrat", { prefix: true }),
  term("diagnosis_or_condition", "malnourish", { prefix: true }),
  term("diagnosis_or_condition", "malnutrition"),
  term("diagnosis_or_condition", "diabet", { prefix: true }),
  term("diagnosis_or_condition", "depress", { prefix: true }),
  term("diagnosis_or_condition", "incontinen", { prefix: true }),
  term("diagnosis_or_condition", "catheter", { prefix: true }),
  term("diagnosis_or_condition", "constipat", { prefix: true }),
  term("diagnosis_or_condition", "seizure", { prefix: true }),
  term("diagnosis_or_condition", "epilep", { prefix: true }),
  term("diagnosis_or_condition", "cancer", { prefix: true }),
  term("diagnosis_or_condition", "tumour", { prefix: true }),
  term("prognosis", "prognos", { prefix: true }),
  term("prognosis", "deteriorat", { prefix: true }),
  term("prognosis", "palliativ", { prefix: true }),
  term("prognosis", "end of life"),
  term("prognosis", "life expectancy"),
  term("prognosis", "terminally"),
  term("prognosis", "dying"),
  term("prognosis", "weeks to live"),
  term("prognosis", "days to live"),
  term("clinical_measurement", "blood pressure"),
  term("clinical_measurement", "blood sugar"),
  term("clinical_measurement", "blood glucose"),
  term("clinical_measurement", "oxygen"),
  term("clinical_measurement", "spo2"),
  term("clinical_measurement", "saturat", { prefix: true }),
  term("clinical_measurement", "heart rate"),
  term("clinical_measurement", "respiratory rate"),
  term("clinical_measurement", "bmi"),
  term("clinical_measurement", "weight loss"),
  term("clinical_measurement", "lost weight"),
  term("medicine", "medicat", { prefix: true }),
  term("medicine", "medicine"),
  term("medicine", "medicines"),
  term("medicine", "antibiotic", { prefix: true }),
  term("medicine", "dose"),
  term("medicine", "doses"),
  term("medicine", "prescri", { prefix: true }),
  term("medicine", "paracetamol"),
  term("medicine", "morphine"),
  term("medicine", "insulin"),
];

export interface FeedClinicalTermMatch {
  /** The words as they appear in the text. */
  readonly found: string;
  readonly kind: FeedClinicalTermKind;
}

function wordMatches(entry: FeedClinicalTerm, position: number, token: string): boolean {
  const expected = entry.words[position] as string;
  const actual = entry.caseSensitive ? token : token.toLowerCase();
  if (entry.prefix && entry.words.length === 1) return actual.startsWith(expected);
  return actual === expected;
}

/** Every clinical term in the text, in order of appearance. */
export function findClinicalTerms(
  text: string,
  terms: readonly FeedClinicalTerm[] = FEED_CLINICAL_TERMS,
): FeedClinicalTermMatch[] {
  const tokens = feedWords(text);
  const matches: FeedClinicalTermMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const entry of terms) {
      if (i + entry.words.length > tokens.length) continue;
      let all = true;
      for (let w = 0; w < entry.words.length && all; w++) {
        all = wordMatches(entry, w, (tokens[i + w] as FeedTextToken).text);
      }
      if (!all) continue;
      const first = tokens[i] as FeedTextToken;
      const last = tokens[i + entry.words.length - 1] as FeedTextToken;
      matches.push({ found: text.slice(first.start, last.end), kind: entry.kind });
    }
  }
  return matches;
}

// ------------------------------------------------------------------------------------------------
// Names of other people, contact details and long numbers
// ------------------------------------------------------------------------------------------------

export interface FeedPersonName {
  readonly givenName: string;
  readonly familyName: string;
}

const POSSESSIVE_ENDINGS = ["'s", "’s", "'", "’"];

/** The word without a possessive ending, so "Bloggs's" is compared as "Bloggs". */
function withoutPossessive(word: string): { base: string; ending: string } {
  for (const ending of POSSESSIVE_ENDINGS) {
    if (word.length > ending.length && word.endsWith(ending)) {
      return { base: word.slice(0, -ending.length), ending };
    }
  }
  return { base: word, ending: "" };
}

function nameWords(name: string): string[] {
  return feedWords(name.trim()).map((t) => t.text);
}

export interface FeedNameMention {
  /** Code-unit offsets of the mention in the text, end exclusive. */
  readonly start: number;
  readonly end: number;
  /** The mention as written. */
  readonly found: string;
  /** The possessive ending on the last word ("'s"), or "". */
  readonly possessive: string;
}

/**
 * Where a name (one or more words) appears, compared word by word and case-sensitively, so
 * "Rose" the name is told apart from "rose" the flower. A possessive ending is allowed on the last
 * word.
 */
export function findNameMentions(text: string, name: string): FeedNameMention[] {
  const words = nameWords(name);
  if (words.length === 0) return [];
  const tokens = feedWords(text);
  const mentions: FeedNameMention[] = [];
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let possessive = "";
    let all = true;
    for (let w = 0; w < words.length && all; w++) {
      const token = (tokens[i + w] as FeedTextToken).text;
      if (token === words[w]) continue;
      const split = withoutPossessive(token);
      if (w === words.length - 1 && split.base === words[w]) possessive = split.ending;
      else all = false;
    }
    if (!all) continue;
    const start = (tokens[i] as FeedTextToken).start;
    const end = (tokens[i + words.length - 1] as FeedTextToken).end;
    mentions.push({ start, end, found: text.slice(start, end), possessive });
  }
  return mentions;
}

/** True when the text contains what looks like an email address (a word, "@", a word). */
export function hasEmailLikeText(text: string): boolean {
  const chars = codePoints(text);
  for (let i = 1; i < chars.length - 1; i++) {
    if (
      (chars[i] as { ch: string }).ch === "@" &&
      isWordCharacter(chars[i - 1]?.ch) &&
      isWordCharacter(chars[i + 1]?.ch)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The longest run of digits, allowing single spaces or hyphens between groups ("943 476 5919").
 * Ten or more digits may be an NHS number or a phone number.
 */
export function longestDigitRun(text: string): number {
  const chars = codePoints(text).map((c) => c.ch);
  let longest = 0;
  let current = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (DIGIT.test(ch)) {
      current++;
      if (current > longest) longest = current;
      continue;
    }
    const separator = ch === " " || ch === "-";
    const digitBefore = i > 0 && DIGIT.test(chars[i - 1] as string);
    const digitAfter = i + 1 < chars.length && DIGIT.test(chars[i + 1] as string);
    if (separator && digitBefore && digitAfter) continue;
    current = 0;
  }
  return longest;
}

/** Digits in a row that a family update never needs: an NHS number is 10, a phone number 11. */
export const FEED_MAX_DIGIT_RUN = 9;
