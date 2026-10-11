/**
 * Forms and assessment engine skeleton (section 9.1). Tenants author forms as data; validated
 * clinical tools ship as locked global templates whose scoring is implemented in code exactly as
 * published (section 5.2), never as tenant-editable formulas. This module validates definitions
 * and answers and computes simple additive scores for tenant forms.
 */

export type FieldType =
  | "text"
  | "long_text"
  | "number"
  | "boolean"
  | "date"
  | "single_choice"
  | "multi_choice";

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  /** Points for additive scoring (tenant forms only). */
  readonly score?: number;
}

export interface FieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly help?: string;
  readonly options?: readonly ChoiceOption[];
  readonly min?: number;
  readonly max?: number;
  /** Show this field only when another field has one of these values. */
  readonly showWhen?: { readonly field: string; readonly equals: readonly (string | boolean)[] };
}

export interface FormDefinition {
  readonly fields: readonly FieldDefinition[];
  /** Tenant forms may sum choice scores into bands; locked tools use coded calculators instead. */
  readonly scoring?: {
    readonly bands: readonly {
      readonly from: number;
      readonly to: number;
      readonly label: string;
    }[];
  };
}

export type AnswerValue = string | number | boolean | readonly string[] | null;
export type Answers = Readonly<Record<string, AnswerValue>>;

export interface FieldProblem {
  readonly field: string;
  readonly problem: "required" | "wrong_type" | "unknown_option" | "out_of_range" | "unknown_field";
}

export interface DefinitionProblem {
  readonly path: string;
  readonly message: string;
}

export function validateDefinition(definition: FormDefinition): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const keys = new Set<string>();
  definition.fields.forEach((field, index) => {
    const path = `fields[${index}]`;
    if (!/^[a-z][a-z0-9_]*$/.test(field.key)) {
      problems.push({
        path,
        message: "Field keys use lower case letters, numbers and underscores.",
      });
    }
    if (keys.has(field.key)) problems.push({ path, message: `Duplicate field key ${field.key}.` });
    keys.add(field.key);
    const isChoice = field.type === "single_choice" || field.type === "multi_choice";
    if (isChoice && (!field.options || field.options.length === 0)) {
      problems.push({ path, message: "Choice fields need at least one option." });
    }
    if (field.showWhen && !keys.has(field.showWhen.field)) {
      problems.push({ path, message: "A condition can only refer to an earlier field." });
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      problems.push({ path, message: "Minimum is greater than maximum." });
    }
  });
  const bands = definition.scoring?.bands ?? [];
  const sorted = [...bands].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.from <= previous.to) {
      problems.push({ path: "scoring.bands", message: "Score bands overlap." });
    }
  }
  return problems;
}

export function isFieldVisible(field: FieldDefinition, answers: Answers): boolean {
  if (!field.showWhen) return true;
  const value = answers[field.showWhen.field];
  return field.showWhen.equals.some((expected) => expected === value);
}

function isEmpty(value: AnswerValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function checkField(field: FieldDefinition, value: AnswerValue): FieldProblem["problem"] | null {
  const options = new Set(field.options?.map((o) => o.value));
  switch (field.type) {
    case "text":
    case "long_text":
      return typeof value === "string" ? null : "wrong_type";
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : "wrong_type";
    case "boolean":
      return typeof value === "boolean" ? null : "wrong_type";
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) return "wrong_type";
      if (
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max)
      ) {
        return "out_of_range";
      }
      return null;
    case "single_choice":
      if (typeof value !== "string") return "wrong_type";
      return options.has(value) ? null : "unknown_option";
    case "multi_choice":
      if (!Array.isArray(value)) return "wrong_type";
      return value.every((v) => options.has(v)) ? null : "unknown_option";
  }
}

export function validateAnswers(definition: FormDefinition, answers: Answers): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const known = new Set(definition.fields.map((f) => f.key));
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) problems.push({ field: key, problem: "unknown_field" });
  }
  for (const field of definition.fields) {
    if (!isFieldVisible(field, answers)) continue;
    const value = answers[field.key];
    if (isEmpty(value)) {
      if (field.required) problems.push({ field: field.key, problem: "required" });
      continue;
    }
    const problem = checkField(field, value as AnswerValue);
    if (problem) problems.push({ field: field.key, problem });
  }
  return problems;
}

export interface ScoreResult {
  readonly total: number;
  readonly band: string | null;
  /** Each field's contribution, so the score can be explained and reproduced. */
  readonly workings: readonly { readonly field: string; readonly points: number }[];
}

export function scoreAnswers(definition: FormDefinition, answers: Answers): ScoreResult {
  const workings: { field: string; points: number }[] = [];
  for (const field of definition.fields) {
    if (!field.options || !isFieldVisible(field, answers)) continue;
    const value = answers[field.key];
    const chosen = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    const points = field.options
      .filter((o) => chosen.includes(o.value))
      .reduce((sum, o) => sum + (o.score ?? 0), 0);
    if (points !== 0) workings.push({ field: field.key, points });
  }
  const total = workings.reduce((sum, w) => sum + w.points, 0);
  const band =
    definition.scoring?.bands.find((b) => total >= b.from && total <= b.to)?.label ?? null;
  return { total, band, workings };
}
