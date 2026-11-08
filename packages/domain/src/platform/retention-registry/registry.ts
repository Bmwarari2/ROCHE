/**
 * The retention registry (retention sweeps plan, section 5.3; ADR-0135 point 3): one entry per
 * table that holds personal data, saying which record class applies, how each trigger date is
 * found, whom the record is about, which parent it is destroyed with and how it is destroyed.
 * It is the single table-to-class source: the export catalogue's `retention` field is checked
 * against it, so the DSAR erasure check and the sweep agree.
 *
 * The registry holds no period: periods come from `retention_class` rows (docs/specs/retention.md),
 * resolved by `resolveRule`. Nothing here reads or destroys a row; the sweep (slice 4 onwards)
 * reads the registry. `packages/db/src/retention-registry.test.ts` checks every table and column
 * it names against the Drizzle schema, and every class against retention.md.
 */

import type { BoundedContext } from "../permissions";
import type { RetentionTrigger } from "../retention";

/** One or more record classes; a record in more than one is kept for the longest (retention.md). */
export type ClassList = readonly [string, ...string[]];

/** Which class applies to a row. */
export type RegistryRetention =
  /** Fixed classes. */
  | { readonly kind: "classes"; readonly classes: ClassList }
  /** The row's own column (`retention_class`), with every value it may take. */
  | { readonly kind: "row_class"; readonly column: string; readonly classes: ClassList }
  /**
   * Decided by a column's value (an outbreak line list's `case_type`), on the row or, with
   * `through`, on the row of `through.table` that the row's `through.key` names (the person's
   * `status`); `otherwise` for any other value.
   */
  | {
      readonly kind: "by_value";
      readonly column: string;
      readonly through?: { readonly table: string; readonly key: string };
      readonly cases: Readonly<Record<string, ClassList>>;
      readonly otherwise?: ClassList;
    }
  /** The parent's class and trigger dates: destroyed with it. */
  | { readonly kind: "as_parent" }
  /**
   * The class of the record it links (`typeColumn` names the table, `idColumn` the row), or the
   * fallback when it links none; an empty fallback is never destroyed (`tenant_policy`).
   */
  | {
      readonly kind: "as_linked";
      readonly typeColumn: string;
      readonly idColumn: string;
      readonly fallback: readonly string[];
    }
  /** Never kept as a record: removed by an existing sweep or lifecycle, at `at`. */
  | {
      readonly kind: "not_retained";
      readonly removedBy: string;
      readonly rateKey: string | null;
      readonly at: DateSource;
    }
  /** Configuration kept while current (retention.md "tenant configuration"); never offered. */
  | { readonly kind: "while_current" }
  /** Kept permanently as proof of records management (retention.md); never offered. */
  | { readonly kind: "permanent" };

/** How one date is found for a row. Every column named is checked against the schema. */
export type DateSource =
  /** A date or time on the row. */
  | { readonly from: "column"; readonly column: string }
  /** The first of these that is set, in order. */
  | { readonly from: "first_of"; readonly columns: readonly [string, string, ...string[]] }
  /** The same date of the parent row. */
  | { readonly from: "parent" }
  /** The same date of the record the row names by table (`typeColumn`) and id (`idColumn`). */
  | { readonly from: "record"; readonly typeColumn: string; readonly idColumn: string }
  /** A column of the row of `table` that the row's `key` names. */
  | {
      readonly from: "lookup";
      readonly table: string;
      readonly key: string;
      readonly column: string;
    }
  /** The latest of the same date of the rows of `table` whose `foreignKey` is this row's id. */
  | { readonly from: "children"; readonly table: string; readonly foreignKey: string }
  /**
   * No column holds it: worked out from `columns` by the rule stated, an answer that is
   * provisional until confirmed (H-NEW-4).
   */
  | { readonly from: "derived"; readonly columns: readonly string[]; readonly rule: string }
  /** The latest `column` of the rows of `table` whose `foreignKey` is this row's id. */
  | {
      readonly from: "latest_child";
      readonly table: string;
      readonly foreignKey: string;
      readonly column: string;
    }
  /** The person's death, else their discharge (`person.deceased_at`, `discharged_at`). */
  | { readonly from: "person_care_ended"; readonly column: string }
  /**
   * The member of staff's leaving date (`leaver_record.leaving_on`), found through the column,
   * which refers to their `staff_profile` or to their `tenant_user`.
   */
  | {
      readonly from: "staff_leaving";
      readonly column: string;
      readonly via: "staff_profile" | "tenant_user";
    }
  /**
   * The end of the pay reference period holding the date. No table stores it; it is worked out
   * from `pay_run.period_end` or the pay frequency (provisional, H-NEW-4).
   */
  | { readonly from: "pay_period_end"; readonly of: DateSource };

/**
 * The trigger facts of `TriggerFacts` (retention-sweep.ts) the entry can supply, each with how it
 * is found. A class's trigger needs its fact (`factsNeeded`).
 */
export interface TriggerSources {
  /** care_ended: the person's death or discharge. */
  readonly careEnded?: DateSource;
  /** last_entry: the entries on the register page or record. */
  readonly entryDates?: DateSource;
  /** record_closed: when the case, complaint, incident or agreement closed. */
  readonly closedAt?: DateSource;
  /** employment_ended_or_75th_birthday: the leaving date. */
  readonly employmentEndedAt?: DateSource;
  /** created: when the record was made. */
  readonly createdAt?: DateSource;
  /** created, for the classes that count from the end of a pay period or financial year. */
  readonly periodEndsAt?: DateSource;
}

export const SUBJECT_KINDS = ["person", "staff", "applicant", "none"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/**
 * Whom the record is about, for holds and longest-wins: the column naming them, or null when
 * they are found through the parent (or the kind is `none`).
 */
export interface RetentionSubject {
  readonly kind: SubjectKind;
  readonly column: string | null;
}

/**
 * How the row is destroyed when its period ends: deleted, or its personal columns cleared and
 * the anonymous row kept where the record has organisational value (provisional, H-1560), or
 * never, for configuration and proof.
 */
export type DestructionMethod =
  | { readonly kind: "delete" }
  | { readonly kind: "clear_columns"; readonly columns: readonly [string, ...string[]] }
  | { readonly kind: "never" };

export interface RetentionTableEntry {
  /** The table: its bare name in `public`, or `auth.<name>`. */
  readonly table: string;
  readonly retention: RegistryRetention;
  readonly facts: TriggerSources;
  readonly subject: RetentionSubject;
  /** Further subjects (a DSAR case about a member of staff; a staff row on a line list). */
  readonly otherSubjects?: readonly RetentionSubject[];
  /**
   * The parent this row belongs to (`column` refers to it): children are destroyed first, and a
   * child with its own class may outlive the parent's due date, so the purge never deletes a
   * parent while a child is kept (plan 5.6).
   */
  readonly parent?: { readonly table: string; readonly column: string };
  readonly method: DestructionMethod;
  /** Human actions behind a provisional answer, or a decision still open. */
  readonly provisional?: readonly string[];
  readonly note?: string;
}

export interface RegistryContext {
  readonly context: BoundedContext;
  readonly entries: readonly RetentionTableEntry[];
}

/** A table known to hold no personal data, with why. */
export interface NoPersonalDataTable {
  readonly table: string;
  readonly reason: string;
}

// Builders, so each entry reads as one line of the mapping.

export const classes = (...list: ClassList): RegistryRetention => ({
  kind: "classes",
  classes: list,
});
export const rowClass = (column: string, ...list: ClassList): RegistryRetention => ({
  kind: "row_class",
  column,
  classes: list,
});
export const byValue = (
  column: string,
  cases: Readonly<Record<string, ClassList>>,
  options: {
    readonly through?: { readonly table: string; readonly key: string };
    readonly otherwise?: ClassList;
  } = {},
): RegistryRetention => ({ kind: "by_value", column, cases, ...options });
export const AS_PARENT: RegistryRetention = { kind: "as_parent" };
export const WHILE_CURRENT: RegistryRetention = { kind: "while_current" };
export const PERMANENT: RegistryRetention = { kind: "permanent" };
export const asLinked = (
  typeColumn: string,
  idColumn: string,
  ...fallback: string[]
): RegistryRetention => ({ kind: "as_linked", typeColumn, idColumn, fallback });

export const col = (column: string): DateSource => ({ from: "column", column });
export const firstOf = (...columns: readonly [string, string, ...string[]]): DateSource => ({
  from: "first_of",
  columns,
});
export const PARENT: DateSource = { from: "parent" };
export const latestChild = (table: string, foreignKey: string, column: string): DateSource => ({
  from: "latest_child",
  table,
  foreignKey,
  column,
});
export const lookup = (table: string, key: string, column: string): DateSource => ({
  from: "lookup",
  table,
  key,
  column,
});
export const children = (table: string, foreignKey: string): DateSource => ({
  from: "children",
  table,
  foreignKey,
});
export const ofRecord = (typeColumn: string, idColumn: string): DateSource => ({
  from: "record",
  typeColumn,
  idColumn,
});
export const derived = (rule: string, ...columns: string[]): DateSource => ({
  from: "derived",
  columns,
  rule,
});
export const careEndedOf = (column = "person_id"): DateSource => ({
  from: "person_care_ended",
  column,
});
export const leavingOf = (
  column: string,
  via: "staff_profile" | "tenant_user" = "tenant_user",
): DateSource => ({ from: "staff_leaving", column, via });
export const payPeriodEnd = (of: DateSource): DateSource => ({ from: "pay_period_end", of });

export const person = (column: string | null = "person_id"): RetentionSubject => ({
  kind: "person",
  column,
});
export const staff = (column: string | null): RetentionSubject => ({ kind: "staff", column });
export const applicant = (column: string | null): RetentionSubject => ({
  kind: "applicant",
  column,
});
export const NO_SUBJECT: RetentionSubject = { kind: "none", column: null };

export const DELETE: DestructionMethod = { kind: "delete" };
export const NEVER: DestructionMethod = { kind: "never" };
export const clearColumns = (...columns: readonly [string, ...string[]]): DestructionMethod => ({
  kind: "clear_columns",
  columns,
});
export const parentIs = (table: string, column: string) => ({ table, column });

/**
 * Classes counted from the end of the pay reference period or financial year the record covers
 * (retention.md notes for these rows): an entry with one of them must say how that end is found.
 */
export const PERIOD_END_CLASSES: readonly string[] = [
  "rota_and_timesheet",
  "payroll_export",
  "financial_record",
];

/** The fact a class's trigger is worked out from (`triggerDate` in retention-sweep.ts). */
export function factsNeeded(
  trigger: RetentionTrigger,
  recordClass: string,
): readonly (keyof TriggerSources)[] {
  switch (trigger) {
    case "care_ended":
      return ["careEnded"];
    case "last_entry":
      return ["entryDates"];
    case "record_closed":
      return ["closedAt"];
    case "employment_ended_or_75th_birthday":
      return ["employmentEndedAt"];
    case "created":
      return PERIOD_END_CLASSES.includes(recordClass)
        ? ["createdAt", "periodEndsAt"]
        : ["createdAt"];
    case "tenant_policy":
      return [];
  }
}

/** Every class an entry can take (none for the kinds that follow another record or never end). */
export function entryClasses(entry: RetentionTableEntry): readonly string[] {
  const r = entry.retention;
  switch (r.kind) {
    case "classes":
    case "row_class":
      return r.classes;
    case "by_value":
      return [...new Set([...Object.values(r.cases).flat(), ...(r.otherwise ?? [])])];
    case "as_linked":
      return r.fallback;
    default:
      return [];
  }
}

/** A table and column an entry names, for the schema check. */
export interface ColumnReference {
  readonly table: string;
  readonly column: string;
  /** What the reference is for, for the failure message. */
  readonly role: string;
}

function dateReferences(table: string, source: DateSource, role: string): ColumnReference[] {
  switch (source.from) {
    case "column":
    case "person_care_ended":
    case "staff_leaving":
      return [{ table, column: source.column, role }];
    case "first_of":
    case "derived":
      return source.columns.map((column) => ({ table, column, role }));
    case "record":
      return [
        { table, column: source.typeColumn, role: `${role} (record table)` },
        { table, column: source.idColumn, role: `${role} (record id)` },
      ];
    case "lookup":
      return [
        { table, column: source.key, role: `${role} (key)` },
        { table: source.table, column: source.column, role },
      ];
    case "latest_child":
      return [
        { table: source.table, column: source.foreignKey, role: `${role} (child key)` },
        { table: source.table, column: source.column, role: `${role} (child date)` },
      ];
    case "children":
      return [{ table: source.table, column: source.foreignKey, role: `${role} (child key)` }];
    case "pay_period_end":
      return dateReferences(table, source.of, role);
    case "parent":
      return [];
  }
}

/** Every column an entry names, on its own table or another. */
export function columnReferences(entry: RetentionTableEntry): ColumnReference[] {
  const { table } = entry;
  const refs: ColumnReference[] = [];
  const r = entry.retention;
  if (r.kind === "row_class") refs.push({ table, column: r.column, role: "class column" });
  if (r.kind === "by_value") {
    if (r.through) {
      refs.push({ table, column: r.through.key, role: "class column (key)" });
      refs.push({ table: r.through.table, column: r.column, role: "class column" });
    } else refs.push({ table, column: r.column, role: "class column" });
  }
  if (r.kind === "as_linked") {
    refs.push({ table, column: r.typeColumn, role: "linked table" });
    refs.push({ table, column: r.idColumn, role: "linked record" });
  }
  if (r.kind === "not_retained") refs.push(...dateReferences(table, r.at, "removal date"));
  for (const [fact, source] of Object.entries(entry.facts) as [string, DateSource][]) {
    refs.push(...dateReferences(table, source, fact));
  }
  for (const s of [entry.subject, ...(entry.otherSubjects ?? [])]) {
    if (s.column) refs.push({ table, column: s.column, role: `${s.kind} subject` });
  }
  if (entry.parent) refs.push({ table, column: entry.parent.column, role: "parent key" });
  if (entry.method.kind === "clear_columns") {
    for (const column of entry.method.columns) refs.push({ table, column, role: "cleared column" });
  }
  return refs;
}

function usesParent(source: DateSource): boolean {
  return source.from === "parent" || (source.from === "pay_period_end" && usesParent(source.of));
}

/**
 * Structural problems with a registry, independent of the schema: a table listed twice, a parent
 * not in the registry or forming a loop, a parent date or subject with no parent, a `none` subject
 * naming a column, a destruction method that does not fit the class kind, a class column with no
 * class. Empty when the registry is sound.
 */
export function registryProblems(entries: readonly RetentionTableEntry[]): string[] {
  const problems: string[] = [];
  const byTable = new Map<string, RetentionTableEntry>();
  for (const e of entries) {
    if (byTable.has(e.table)) problems.push(`${e.table}: listed twice`);
    byTable.set(e.table, e);
  }
  for (const e of entries) {
    const where = e.table;
    if (e.parent && !byTable.has(e.parent.table))
      problems.push(`${where}: parent ${e.parent.table} has no entry`);
    if (e.parent?.table === e.table) problems.push(`${where}: is its own parent`);
    const needsParent =
      e.retention.kind === "as_parent" ||
      Object.values(e.facts).some((s) => usesParent(s as DateSource)) ||
      (e.subject.kind !== "none" && e.subject.column === null);
    if (needsParent && !e.parent) problems.push(`${where}: follows a parent it does not name`);
    for (const s of [e.subject, ...(e.otherSubjects ?? [])]) {
      if (s.kind === "none" && s.column !== null)
        problems.push(`${where}: a subject of none names ${s.column}`);
    }
    const keeps = e.retention.kind === "while_current" || e.retention.kind === "permanent";
    if (keeps !== (e.method.kind === "never"))
      problems.push(`${where}: method ${e.method.kind} does not fit ${e.retention.kind}`);
    if (e.retention.kind === "by_value" && Object.keys(e.retention.cases).length === 0)
      problems.push(`${where}: a class by value with no values`);
  }
  // A parent chain that loops would never let a child be destroyed first.
  for (const e of entries) {
    const seen = new Set<string>([e.table]);
    let next = e.parent ? byTable.get(e.parent.table) : undefined;
    while (next) {
      if (seen.has(next.table)) {
        problems.push(`${e.table}: parent chain loops at ${next.table}`);
        break;
      }
      seen.add(next.table);
      next = next.parent ? byTable.get(next.parent.table) : undefined;
    }
  }
  return problems;
}

/**
 * What the export catalogue's `retention` field must say for an entry (the catalogue is checked
 * against this): the class when there is exactly one, `by_category` when it depends on the row
 * or more than one class applies, the parent's value for a child, `as_subject` for a link,
 * `operational` for staged or transient data never kept, `tenant_configuration` for
 * configuration and `permanent` for proof. Null for an entry whose parent has no entry.
 */
export function catalogueRetentionFor(
  entry: RetentionTableEntry,
  entries: readonly RetentionTableEntry[],
): string | null {
  const r = entry.retention;
  switch (r.kind) {
    case "classes":
    case "row_class":
    case "by_value": {
      const all = entryClasses(entry);
      return all.length === 1 ? (all[0] as string) : "by_category";
    }
    case "as_parent": {
      const parent = entries.find((p) => p.table === entry.parent?.table);
      return parent && parent !== entry ? catalogueRetentionFor(parent, entries) : null;
    }
    case "as_linked":
      return "as_subject";
    case "not_retained":
      return "operational";
    case "while_current":
      return "tenant_configuration";
    case "permanent":
      return "permanent";
  }
}

/** An entry deleted at the end of its period unless `extra` says otherwise. */
export function entry(
  table: string,
  retention: RegistryRetention,
  facts: TriggerSources,
  subject: RetentionSubject,
  extra: Partial<Omit<RetentionTableEntry, "table" | "retention" | "facts" | "subject">> = {},
): RetentionTableEntry {
  return { table, retention, facts, subject, method: DELETE, ...extra };
}

/** A record about a person receiving care, kept from when their care ended. */
export function personRecord(
  table: string,
  recordClass: string,
  extra: Partial<Omit<RetentionTableEntry, "table">> = {},
): RetentionTableEntry {
  return {
    table,
    retention: classes(recordClass),
    facts: { careEnded: careEndedOf("person_id") },
    subject: person("person_id"),
    method: DELETE,
    ...extra,
  };
}

/** Part of a member of staff's file (the organisation's chosen staff file row). */
export function staffFileRecord(
  table: string,
  column: string,
  via: "staff_profile" | "tenant_user",
  extra: Partial<Omit<RetentionTableEntry, "table">> = {},
): RetentionTableEntry {
  return {
    table,
    retention: classes("staff_file"),
    facts: { employmentEndedAt: leavingOf(column, via) },
    subject: staff(column),
    method: DELETE,
    ...extra,
  };
}

/** A child destroyed with its parent, taking the parent's class and dates. */
export function childOf(
  table: string,
  parentTable: string,
  column: string,
  subject: RetentionSubject,
  extra: Partial<Omit<RetentionTableEntry, "table" | "parent">> = {},
): RetentionTableEntry {
  return {
    table,
    retention: AS_PARENT,
    facts: {},
    subject,
    parent: { table: parentTable, column },
    method: DELETE,
    ...extra,
  };
}
