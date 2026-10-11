/**
 * Optional plain-English hints for template authors (comms.md rule 9; packages/ui/CONTENT.md).
 * Advisory only: they never block approval. Deliberately simple, and written as loops rather than
 * regular expressions so they cannot backtrack on long text.
 */

/** Why: plain-English guidance keeps sentences to about 25 words or fewer. */
export const MAX_SENTENCE_WORDS = 25;
/** Why: short all-capital words are usually acronyms; longer ones are usually shouting. */
const MIN_SHOUTING_LENGTH = 4;

/** Upper-case words that are not shouting. */
export const TEMPLATE_ACRONYMS: ReadonlySet<string> = new Set([
  "CQC",
  "NHS",
  "DNACPR",
  "IDDSI",
  "LPA",
  "MAR",
  "PEEP",
  "ICO",
  "DPA",
  "CHC",
  "FNC",
  "VAT",
  "BACS",
  "UKHSA",
  "RIDDOR",
]);

export type TemplateStyleWarningKind = "long_sentence" | "capitals" | "title_case_name";

export interface TemplateStyleWarning {
  readonly kind: TemplateStyleWarningKind;
  readonly text: string;
  readonly message: string;
}

function isLetter(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

function words(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

function lettersOnly(word: string): string {
  let out = "";
  for (const ch of word) if (isLetter(ch)) out += ch;
  return out;
}

function sentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let previous = "";
  for (const ch of text) {
    const paragraphBreak = ch === "\n" && previous === "\n";
    if (ch === "." || ch === "!" || ch === "?" || paragraphBreak) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
    previous = ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Hints for a template's name and body: long sentences, capitals for emphasis, title case. */
export function templateStyleWarnings(input: {
  readonly name: string;
  readonly body: string;
}): readonly TemplateStyleWarning[] {
  const warnings: TemplateStyleWarning[] = [];
  for (const sentence of sentences(input.body)) {
    const count = words(sentence).length;
    if (count > MAX_SENTENCE_WORDS) {
      warnings.push({
        kind: "long_sentence",
        text: sentence.slice(0, 60),
        message: `This sentence has ${count} words. Try to keep sentences to ${MAX_SENTENCE_WORDS} or fewer.`,
      });
    }
  }
  const seen = new Set<string>();
  for (const word of words(input.body)) {
    if (word.startsWith("{{")) continue;
    const letters = lettersOnly(word);
    if (
      letters.length >= MIN_SHOUTING_LENGTH &&
      letters === letters.toUpperCase() &&
      !TEMPLATE_ACRONYMS.has(letters) &&
      !seen.has(letters)
    ) {
      seen.add(letters);
      warnings.push({
        kind: "capitals",
        text: letters,
        message: `Avoid capitals for emphasis: "${letters}".`,
      });
    }
  }
  // Title case: every word after the first starts with a capital, small words included ("To").
  // Names of places alone ("Welcome to Harbour House") keep a lower-case word and pass.
  const nameWords = words(input.name)
    .slice(1)
    .map(lettersOnly)
    .filter((w) => w.length > 0 && !TEMPLATE_ACRONYMS.has(w));
  if (nameWords.length >= 2 && nameWords.every((w) => w[0] === w[0]?.toUpperCase())) {
    warnings.push({
      kind: "title_case_name",
      text: input.name,
      message: "Use sentence case for the name: a capital letter only at the start and for names.",
    });
  }
  return warnings;
}
