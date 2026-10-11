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
// Normalising text before any check (security review: hidden characters and lookalike letters)
// ------------------------------------------------------------------------------------------------

/** Format characters that render as nothing but split words: removed before any check. */
function isInvisible(code: number): boolean {
  return (
    code === 0x00ad || // soft hyphen
    code === 0x034f ||
    code === 0x061c ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x17b4 ||
    code === 0x17b5 ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) || // zero-width space, joiners, direction marks
    (code >= 0x202a && code <= 0x202e) || // bidirectional embeddings and overrides
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) || // bidirectional isolates
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f) // tag characters
  );
}

/**
 * Unicode NFKC (full-width letters, digits and "＠" become plain ones) with invisible format
 * characters removed. Applied to every word a member of staff writes before it is checked or
 * published.
 */
export function normaliseFeedText(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKC")) {
    if (!isInvisible(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/** Cyrillic and Greek letters that look like Latin ones, folded only for matching. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a",
  е: "e",
  і: "i",
  ј: "j",
  к: "k",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  ѕ: "s",
  ԁ: "d",
  һ: "h",
  ӏ: "l",
  ԛ: "q",
  ԝ: "w",
  А: "A",
  В: "B",
  Е: "E",
  І: "I",
  Ј: "J",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Ѕ: "S",
  Т: "T",
  У: "Y",
  Х: "X",
  // Greek
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  υ: "u",
  χ: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  // Latin dotless i
  ı: "i",
};

/**
 * The text with lookalike letters folded to Latin, for matching only. Every fold is one UTF-16
 * code unit for one, so offsets in the folded text are offsets in the original.
 */
export function foldLookalikes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    out += LOOKALIKES[ch] ?? ch;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Vocabularies: clinical terms (refused), events and wellbeing claims (need confirmation)
// ------------------------------------------------------------------------------------------------

export const FEED_CLINICAL_TERM_KINDS = [
  "validated_tool_or_score",
  "diagnosis_or_condition",
  "prognosis",
  "clinical_measurement",
  "medicine",
] as const;
export type FeedClinicalTermKind = (typeof FEED_CLINICAL_TERM_KINDS)[number];

export interface FeedTerm<K extends string = string> {
  /** Lower-case words in order, unless `caseSensitive`. */
  readonly words: readonly string[];
  readonly kind: K;
  /** A one-word term that also matches words starting with it ("diagnos" matches "diagnosed"). */
  readonly prefix?: boolean;
  /** For terms that are ordinary words in lower case ("MUST", "NEWS"). */
  readonly caseSensitive?: boolean;
  /** The term does not count when the next word is one of these ("fell asleep"). */
  readonly notFollowedBy?: readonly string[];
  /** The term does not count when the next word is a number ("999" in "999 123 4567"). */
  readonly notFollowedByNumber?: boolean;
}

export type FeedClinicalTerm = FeedTerm<FeedClinicalTermKind>;

const term = <K extends string>(
  kind: K,
  words: string,
  options: {
    prefix?: boolean;
    caseSensitive?: boolean;
    notFollowedBy?: readonly string[];
    notFollowedByNumber?: boolean;
  } = {},
): FeedTerm<K> => ({ kind, words: words.split(" "), ...options });

/**
 * Words that make a family update read as a score, a diagnosis or a prognosis, or that carry
 * clinical measurements or medicines. A backstop behind the staff member's decision to share a
 * note: it is not complete, and a match refuses the text so the writer can say it another way.
 * The validated tools are the ones in the medical-device boundary (section 5).
 *
 * "MUST" is matched in capitals, and "must" in any case only beside "score", "screening",
 * "screen", "risk" or "result": "Must" opens ordinary sentences, and the tool's name alone in
 * mixed case is rare enough that refusing every "Must" would teach staff to ignore the check.
 */
export const FEED_CLINICAL_TERMS: readonly FeedClinicalTerm[] = [
  term("validated_tool_or_score", "news2"),
  term("validated_tool_or_score", "NEWS", { caseSensitive: true }),
  term("validated_tool_or_score", "MUST", { caseSensitive: true }),
  term("validated_tool_or_score", "must score"),
  term("validated_tool_or_score", "must screening"),
  term("validated_tool_or_score", "must screen"),
  term("validated_tool_or_score", "must risk"),
  term("validated_tool_or_score", "must result"),
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
  term("medicine", "antibiotic", { prefix: true }),
  term("medicine", "dose"),
  term("medicine", "prescri", { prefix: true }),
  term("medicine", "paracetamol"),
  term("medicine", "morphine"),
  term("medicine", "insulin"),
];

/**
 * Words that announce something the family should hear from a person, not read in a feed: a fall,
 * a hospital or emergency visit, a death, an injury, a safeguarding or police matter (HZ-060,
 * HZ-061). A match needs a manager's confirmation, with a reason, before the update is published.
 */
export const FEED_EVENT_TERMS: readonly FeedTerm<"event">[] = [
  term("event", "fall", { notFollowedBy: ["asleep"] }),
  term("event", "fell", { notFollowedBy: ["asleep"] }),
  term("event", "fallen", { notFollowedBy: ["asleep"] }),
  term("event", "found on the floor"),
  term("event", "hospital"),
  term("event", "hospitalised"),
  term("event", "hospitalized"),
  term("event", "A E", { caseSensitive: true }),
  term("event", "a and e"),
  term("event", "accident and emergency"),
  term("event", "emergency"),
  term("event", "ambulance"),
  term("event", "paramedic", { prefix: true }),
  term("event", "999", { notFollowedByNumber: true }),
  term("event", "out of hours"),
  term("event", "admitted"),
  term("event", "died"),
  term("event", "dies"),
  term("event", "passed away"),
  term("event", "death", { prefix: true }),
  term("event", "deceased"),
  term("event", "funeral"),
  term("event", "stroke"),
  term("event", "heart attack"),
  term("event", "injur", { prefix: true }),
  term("event", "bleed", { prefix: true }),
  term("event", "bruis", { prefix: true }),
  term("event", "collaps", { prefix: true }),
  term("event", "unconscious"),
  term("event", "unresponsive"),
  term("event", "chok", { prefix: true }),
  term("event", "resuscitat", { prefix: true }),
  term("event", "cpr"),
  term("event", "safeguard", { prefix: true }),
  term("event", "police"),
  term("event", "missing"),
  term("event", "abscond", { prefix: true }),
  term("event", "restrain", { prefix: true }),
  term("event", "abus", { prefix: true }),
  term("event", "neglect", { prefix: true }),
  term("event", "assault", { prefix: true }),
  term("event", "incident"),
  term("event", "gp"),
  term("event", "doctor", { prefix: true }),
];

/**
 * Words that claim how the person is rather than say what happened (HZ-061). A match needs a
 * manager's confirmation, with a reason, before the update is published.
 */
export const FEED_WELLBEING_TERMS: readonly FeedTerm<"wellbeing_claim">[] = [
  term("wellbeing_claim", "settled"),
  term("wellbeing_claim", "happy", { notFollowedBy: ["birthday", "christmas", "new", "easter"] }),
  term("wellbeing_claim", "happier"),
  term("wellbeing_claim", "cheerful"),
  term("wellbeing_claim", "contented"),
  term("wellbeing_claim", "comfortabl", { prefix: true }),
  term("wellbeing_claim", "good spirits"),
  term("wellbeing_claim", "high spirits"),
  term("wellbeing_claim", "no concern"),
  term("wellbeing_claim", "no problem"),
  term("wellbeing_claim", "no issue"),
  term("wellbeing_claim", "nothing to report"),
  term("wellbeing_claim", "all is well"),
  term("wellbeing_claim", "all well"),
  term("wellbeing_claim", "is well"),
  term("wellbeing_claim", "was well"),
  term("wellbeing_claim", "seems well"),
  term("wellbeing_claim", "seemed well"),
  term("wellbeing_claim", "looks well"),
  term("wellbeing_claim", "looked well"),
  term("wellbeing_claim", "keeping well"),
  term("wellbeing_claim", "doing well"),
  term("wellbeing_claim", "is fine"),
  term("wellbeing_claim", "was fine"),
  term("wellbeing_claim", "seems fine"),
  term("wellbeing_claim", "seemed fine"),
  term("wellbeing_claim", "all fine"),
  term("wellbeing_claim", "doing fine"),
  term("wellbeing_claim", "doing great"),
  term("wellbeing_claim", "well in herself"),
  term("wellbeing_claim", "well in himself"),
  term("wellbeing_claim", "well in themselves"),
  term("wellbeing_claim", "fine in herself"),
  term("wellbeing_claim", "fine in himself"),
  term("wellbeing_claim", "on good form"),
  term("wellbeing_claim", "usual self"),
  term("wellbeing_claim", "old self"),
  term("wellbeing_claim", "back to normal"),
];

export interface FeedTermMatch<K extends string = string> {
  /** The words as they appear in the (normalised) text. */
  readonly found: string;
  readonly kind: K;
}

export type FeedClinicalTermMatch = FeedTermMatch<FeedClinicalTermKind>;

/** Words split at hyphens, so "COVID-19" is checked as "COVID" and "19", "anti-depressants" as both parts. */
function termParts(text: string): FeedTextToken[] {
  const parts: FeedTextToken[] = [];
  for (const token of feedWords(text)) {
    let start = token.start;
    for (let i = token.start; i <= token.end; i++) {
      if (i === token.end || text[i] === "-") {
        if (i > start) parts.push({ text: text.slice(start, i), start, end: i });
        start = i + 1;
      }
    }
  }
  return parts;
}

/** The word and its likely singular and non-possessive forms ("UTIs", "sores", "Ada's"). */
function wordForms(word: string): string[] {
  const forms = [word];
  const base = withoutPossessive(word).base;
  if (base !== word) forms.push(base);
  for (const w of [word, base]) {
    if (w.length > 3 && (w.endsWith("es") || w.endsWith("ES"))) forms.push(w.slice(0, -2));
    if (w.length > 2 && (w.endsWith("s") || w.endsWith("S"))) forms.push(w.slice(0, -1));
  }
  return forms;
}

function wordMatches(entry: FeedTerm, position: number, word: string): boolean {
  const expected = entry.words[position] as string;
  const forms = wordForms(entry.caseSensitive ? word : word.toLowerCase());
  if (entry.prefix && entry.words.length === 1) return forms.some((f) => f.startsWith(expected));
  return forms.includes(expected);
}

/**
 * Every term of a vocabulary in the text, in order of appearance. The text is normalised (NFKC,
 * no invisible characters) and lookalike letters are folded before matching; hyphenated words are
 * checked part by part and plural and possessive endings are removed.
 */
export function findFeedTerms<K extends string>(
  text: string,
  terms: readonly FeedTerm<K>[],
): FeedTermMatch<K>[] {
  const normalised = normaliseFeedText(text);
  const folded = foldLookalikes(normalised);
  const parts = termParts(folded);
  const matches: FeedTermMatch<K>[] = [];
  for (let i = 0; i < parts.length; i++) {
    for (const entry of terms) {
      if (i + entry.words.length > parts.length) continue;
      let all = true;
      for (let w = 0; w < entry.words.length && all; w++) {
        all = wordMatches(entry, w, (parts[i + w] as FeedTextToken).text);
      }
      if (!all) continue;
      const next = parts[i + entry.words.length]?.text.toLowerCase();
      if (next !== undefined && entry.notFollowedBy?.includes(next)) continue;
      if (next !== undefined && entry.notFollowedByNumber && DIGIT.test(next.charAt(0))) continue;
      const first = parts[i] as FeedTextToken;
      const last = parts[i + entry.words.length - 1] as FeedTextToken;
      matches.push({ found: normalised.slice(first.start, last.end), kind: entry.kind });
    }
  }
  return matches;
}

/** Every clinical term in the text, in order of appearance. */
export function findClinicalTerms(
  text: string,
  terms: readonly FeedClinicalTerm[] = FEED_CLINICAL_TERMS,
): FeedClinicalTermMatch[] {
  return findFeedTerms(text, terms);
}

/** Events and wellbeing claims that need a manager's confirmation (HZ-060, HZ-061). */
export function findConfirmationTerms(text: string): FeedTermMatch<"event" | "wellbeing_claim">[] {
  return [...findFeedTerms(text, FEED_EVENT_TERMS), ...findFeedTerms(text, FEED_WELLBEING_TERMS)];
}

// ------------------------------------------------------------------------------------------------
// Names of other people, contact details and long numbers
// ------------------------------------------------------------------------------------------------

export interface FeedPersonName {
  readonly givenName: string;
  readonly familyName: string;
  /** The name the person prefers, if not their given name. */
  readonly preferredName?: string | null;
  /** Other names the person is known by ("Bob" for Robert). */
  readonly knownAs?: readonly string[];
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

function nameWords(name: string, ignoreCase: boolean): string[] {
  const folded = foldLookalikes(normaliseFeedText(name).trim());
  return feedWords(folded).map((t) => (ignoreCase ? t.text.toLowerCase() : t.text));
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
 * Where a name (one or more words) appears, compared word by word with lookalike letters folded.
 * By default the comparison is case-sensitive, so "Rose" the name is told apart from "rose" the
 * flower; full names and surnames are compared without regard to case (`ignoreCase`). A
 * possessive ending is allowed on the last word. The text must already be normalised
 * (`normaliseFeedText`), so the offsets returned are offsets in it.
 */
export function findNameMentions(
  text: string,
  name: string,
  options: { readonly ignoreCase?: boolean } = {},
): FeedNameMention[] {
  const ignoreCase = options.ignoreCase === true;
  const words = nameWords(name, ignoreCase);
  if (words.length === 0) return [];
  const tokens = feedWords(foldLookalikes(text));
  const mentions: FeedNameMention[] = [];
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let possessive = "";
    let all = true;
    for (let w = 0; w < words.length && all; w++) {
      const raw = (tokens[i + w] as FeedTextToken).text;
      const token = ignoreCase ? raw.toLowerCase() : raw;
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
  const chars = codePoints(normaliseFeedText(text));
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

/** Characters that may sit between groups of one number: "(01632) 960 001", "943.476.5919". */
const NUMBER_SEPARATORS = new Set([" ", "-", ".", "(", ")", " "]);
const MAX_SEPARATOR_RUN = 3;

/**
 * The longest run of digits in one number, allowing up to three spaces, hyphens, points or
 * brackets between groups. Ten or more digits may be an NHS number or a phone number.
 */
export function longestDigitRun(text: string): number {
  const chars = codePoints(normaliseFeedText(text)).map((c) => c.ch);
  let longest = 0;
  let current = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (DIGIT.test(ch)) {
      current++;
      if (current > longest) longest = current;
      continue;
    }
    if (current > 0 && NUMBER_SEPARATORS.has(ch)) {
      let j = i;
      while (
        j < chars.length &&
        j - i < MAX_SEPARATOR_RUN &&
        NUMBER_SEPARATORS.has(chars[j] as string)
      )
        j++;
      if (j < chars.length && DIGIT.test(chars[j] as string)) {
        i = j - 1;
        continue;
      }
    }
    current = 0;
  }
  return longest;
}

/** Digits in a row that a family update never needs: an NHS number is 10, a phone number 11. */
export const FEED_MAX_DIGIT_RUN = 9;
