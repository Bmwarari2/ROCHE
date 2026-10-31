/**
 * The DSAR workbench rules (platform.md, Phase 2: the DSAR workbench; PLAT-022; ADR-0090). The
 * clock itself is `dsarClock` in data-rights.ts. This module decides where a subject's records are
 * looked for, checks the decisions a person makes about each record, builds the bundle and assesses
 * erasure against the retention schedule. Nothing here redacts, withholds or erases on its own: it
 * highlights and checks, and a person decides (UK GDPR Art 22; ADR-0090).
 */

import { isRealDate } from "./data-rights";
import type { ColumnSpec, ExportTableDefinition } from "./export-catalogue";
import { type RetentionRule, retentionDecision } from "./retention";

export type DsarSubjectKind = "person" | "contact" | "staff";
export type DsarRequestKind = "access" | "rectification" | "erasure" | "portability";
export type DsarRequesterKind = "subject" | "representative";
export type DsarAuthority =
  | "lpa_health_welfare"
  | "lpa_property_finance"
  | "deputy"
  | "written_authority"
  | "other";
export type DsarItemDecision = "pending" | "disclose" | "redact" | "withhold";

export interface DsarSubjectColumn {
  /** Table name without the schema. */
  readonly table: string;
  readonly column: string;
}

export interface DsarSubjectMap {
  readonly person: readonly DsarSubjectColumn[];
  readonly contact: readonly DsarSubjectColumn[];
  readonly staff: readonly DsarSubjectColumn[];
  /** Tables with personal data and no column naming a subject: listed in the case, never skipped silently. */
  readonly notSearched: readonly string[];
}

/**
 * Columns that record who wrote a row, not something the member of staff did as a subject: every
 * row has them, so collecting by them would return the whole of a person's working life as a
 * subject access bundle. Their own row and the columns naming their actions are collected instead.
 */
export const STAFF_ROW_COLUMNS_NOT_COLLECTED: readonly string[] = ["created_by", "updated_by"];

function isSecret(spec: ColumnSpec): boolean {
  return spec === "secret" || (typeof spec === "object" && spec.class === "secret");
}

function byTableThenColumn(a: DsarSubjectColumn, b: DsarSubjectColumn): number {
  return a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table);
}

/** Where a subject's records are looked for, read from the export catalogue (ADR-0090). */
export function dsarSubjectMap(
  tables: Readonly<Record<string, ExportTableDefinition>>,
): DsarSubjectMap {
  const person: DsarSubjectColumn[] = [];
  const contact: DsarSubjectColumn[] = [];
  const staff: DsarSubjectColumn[] = [];
  const notSearched: string[] = [];
  for (const [key, def] of Object.entries(tables)) {
    if (def.treatment !== "tenant_rows" || !def.personal) continue;
    const table = key.replace(/^[a-z_]+\./, "");
    let found = false;
    for (const [column, spec] of Object.entries(def.columns)) {
      if (isSecret(spec)) continue;
      const entry = { table, column };
      if ((table === "person" && column === "id") || column === "person_id") person.push(entry);
      else if ((table === "contact" && column === "id") || column === "contact_id")
        contact.push(entry);
      else if (
        (table === "tenant_user" && column === "id") ||
        column.endsWith("tenant_user_id") ||
        (column.endsWith("_by") && !STAFF_ROW_COLUMNS_NOT_COLLECTED.includes(column))
      )
        staff.push(entry);
      else continue;
      found = true;
    }
    if (!found) notSearched.push(table);
  }
  return {
    person: person.sort(byTableThenColumn),
    contact: contact.sort(byTableThenColumn),
    staff: staff.sort(byTableThenColumn),
    notSearched: notSearched.sort(),
  };
}

export interface NameHighlight {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where other people's names appear in a record, so the reviewer can decide whether to redact them
 * (DPA 2018 Sch 2 para 16). Whole words, any case, longest name first, no overlaps. A highlight is
 * a prompt for a person, never a redaction.
 */
export function findThirdPartyNames(text: string, names: readonly string[]): NameHighlight[] {
  if (text.length === 0) return [];
  const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  const taken: NameHighlight[] = [];
  for (const name of wanted) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu");
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some((h) => start < h.end && end > h.start)) continue;
      taken.push({ name, start, end });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

export interface ItemDecisionInput {
  readonly decision: Exclude<DsarItemDecision, "pending">;
  readonly redactedFields: readonly string[];
  readonly reason: string | null;
}

export type ItemDecisionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: "fields_required" | "unknown_field" | "reason_required";
      readonly field?: string;
    };

/** A redaction names the fields and a reason; withholding a record names a reason (platform.md rule 5). */
export function checkItemDecision(
  input: ItemDecisionInput,
  recordFields: readonly string[],
): ItemDecisionCheck {
  if (input.decision === "disclose") return { ok: true };
  if (input.decision === "redact") {
    if (input.redactedFields.length === 0) return { ok: false, problem: "fields_required" };
    const unknown = input.redactedFields.find((f) => !recordFields.includes(f));
    if (unknown !== undefined) return { ok: false, problem: "unknown_field", field: unknown };
  }
  if ((input.reason ?? "").trim().length === 0) return { ok: false, problem: "reason_required" };
  return { ok: true };
}

export interface BundleReadiness {
  readonly ready: boolean;
  readonly pending: number;
  /** Disclosed in full or with redactions. */
  readonly disclosed: number;
  readonly withheld: number;
}

/** The bundle is built only when a person has decided every record (platform.md rule 6). */
export function bundleReadiness(
  items: readonly { readonly decision: DsarItemDecision }[],
): BundleReadiness {
  let pending = 0;
  let disclosed = 0;
  let withheld = 0;
  for (const item of items) {
    if (item.decision === "pending") pending += 1;
    else if (item.decision === "withhold") withheld += 1;
    else disclosed += 1;
  }
  return { ready: items.length > 0 && pending === 0, pending, disclosed, withheld };
}

export const REDACTED_MARK = "[redacted]";

export function applyRedactions(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const field of fields) if (field in out) out[field] = REDACTED_MARK;
  return out;
}

export interface ErasureCandidate {
  readonly table: string;
  readonly recordId: string;
  readonly rule: RetentionRule;
  readonly legalHold: boolean;
  /** The trigger event (care ended, record closed); null when it has not happened yet. */
  readonly triggerDate: Date | null;
}

export interface ErasureAssessment {
  readonly table: string;
  readonly recordId: string;
  readonly recordClass: string;
  readonly outcome: "held" | "retained" | "erasable";
  readonly reason:
    | "legal_hold"
    | "tenant_policy"
    | "trigger_not_reached"
    | "retention_period"
    | "period_ended";
  readonly until?: Date;
}

/**
 * Whether each record could be erased now (UK GDPR Art 17(3)(b) and (c): records kept to meet a
 * legal obligation or for health and social care are not erased while their period runs). Recorded
 * on the case only; the retention engine destroys records, never the workbench (ADR-0090).
 */
export function erasureAssessment(
  candidates: readonly ErasureCandidate[],
  now: Date,
): ErasureAssessment[] {
  return candidates.map((c): ErasureAssessment => {
    const base = { table: c.table, recordId: c.recordId, recordClass: c.rule.recordClass };
    if (c.legalHold) return { ...base, outcome: "held", reason: "legal_hold" };
    if (c.rule.trigger === "tenant_policy")
      return { ...base, outcome: "retained", reason: "tenant_policy" };
    if (c.triggerDate === null)
      return { ...base, outcome: "retained", reason: "trigger_not_reached" };
    const decision = retentionDecision(
      c.rule,
      { triggerDate: c.triggerDate, legalHold: false },
      now,
    );
    if (decision.status === "retain")
      return { ...base, outcome: "retained", reason: "retention_period", until: decision.until };
    return { ...base, outcome: "erasable", reason: "period_ended" };
  });
}

/**
 * Portability (UK GDPR Art 20) applies only to processing on consent or contract by automated
 * means. Staff records rest on the employment contract; care records rest on legal obligation and
 * public task (Art 6(1)(c) and (e), Art 9(2)(h)), so a person or contact gets access instead.
 */
export function portabilityApplies(kind: DsarSubjectKind): {
  readonly applies: boolean;
  readonly basis: "contract" | "legal_obligation_or_public_task";
} {
  return kind === "staff"
    ? { applies: true, basis: "contract" }
    : { applies: false, basis: "legal_obligation_or_public_task" };
}

export interface NewDsarCaseInput {
  readonly subjectKind: DsarSubjectKind;
  readonly subjectPersonId: string | null;
  readonly subjectContactId: string | null;
  readonly subjectStaffId: string | null;
  readonly requesterKind: DsarRequesterKind;
  readonly authority: DsarAuthority | null;
  /** A representative's name, as given; the subject's own request has none. */
  readonly requesterName?: string | null;
  /** ISO date (yyyy-mm-dd). */
  readonly receivedOn: string;
  readonly today: string;
}

export type NewDsarCaseCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem:
        | "subject_mismatch"
        | "authority_required"
        | "authority_not_for_subject"
        | "requester_name_required"
        | "received_in_future"
        | "invalid_date";
    };

/** A case names exactly one subject of its kind, and a representative's authority (platform.md rule 1). */
export function checkNewDsarCase(input: NewDsarCaseInput): NewDsarCaseCheck {
  const has = (v: string | null) => v !== null && v.length > 0;
  const shape: Record<DsarSubjectKind, boolean> = {
    person:
      has(input.subjectPersonId) && !has(input.subjectContactId) && !has(input.subjectStaffId),
    contact:
      has(input.subjectPersonId) && has(input.subjectContactId) && !has(input.subjectStaffId),
    staff: !has(input.subjectPersonId) && !has(input.subjectContactId) && has(input.subjectStaffId),
  };
  if (!shape[input.subjectKind]) return { ok: false, problem: "subject_mismatch" };
  if (input.requesterKind === "representative") {
    if (input.authority === null) return { ok: false, problem: "authority_required" };
    if ((input.requesterName ?? "").trim().length === 0)
      return { ok: false, problem: "requester_name_required" };
  } else if (input.authority !== null) {
    // The subject asks for themselves: an authority would describe someone else (#149 M6).
    return { ok: false, problem: "authority_not_for_subject" };
  }
  if (!isRealDate(input.receivedOn)) return { ok: false, problem: "invalid_date" };
  if (input.receivedOn > input.today) return { ok: false, problem: "received_in_future" };
  return { ok: true };
}

const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where an issued bundle is kept: organisation, case and bundle ids only (#149 M3). */
export function dsarBundleStorageKey(tenantId: string, caseId: string, bundleId: string): string {
  if (![tenantId, caseId, bundleId].every((id) => UUID_SHAPED.test(id))) {
    throw new RangeError("DSAR bundle keys are built from UUIDs only.");
  }
  return `tenants/${tenantId.toLowerCase()}/dsar/${caseId.toLowerCase()}/${bundleId.toLowerCase()}.json`;
}

export type DsarNotSearchedReason = "no_subject_column" | "member_scoped";

export interface DsarNotSearched {
  readonly table: string;
  readonly reason: DsarNotSearchedReason;
  /** What the reviewer does about it, in plain words (case view and bundle cover). */
  readonly guidance: string;
}

/**
 * Tables in the subject map whose read policy depends on the member reading them, with no
 * organisation-wide alternative: the collector's organisation-wide read may see only part of them,
 * so each is listed for a search by hand, never left as a silent gap (#149 follow-up). Kept in step
 * with the database by `packages/db/test/data-rights.test.ts`; empty today (the member-dependent
 * tables, `dpia` and `sub_processor_response`, hold no personal data in the catalogue). A collector
 * that reads them through a definer function is the follow-up (ADR-0090).
 */
export const DSAR_MEMBER_SCOPED_TABLES: Readonly<Record<string, string>> = {};

const NOT_SEARCHED_GUIDANCE: Record<DsarNotSearchedReason, string> = {
  no_subject_column:
    "No column in this table names the subject. Search it by hand, following the records collected.",
  member_scoped:
    "Who can read this table depends on the member reading it, so the search may have missed rows. Search it by hand.",
};

/** The tables a case could not search fully, each with its reason and what to do (rule 3). */
export function dsarNotSearched(
  map: DsarSubjectMap,
  kind: DsarSubjectKind,
  memberScoped: Readonly<Record<string, string>> = DSAR_MEMBER_SCOPED_TABLES,
): DsarNotSearched[] {
  const scoped = [...new Set(map[kind].map((e) => e.table))].filter((t) => t in memberScoped);
  return [
    ...map.notSearched.map((table) => ({ table, reason: "no_subject_column" as const })),
    ...scoped.map((table) => ({ table, reason: "member_scoped" as const })),
  ]
    .sort((a, b) => a.table.localeCompare(b.table))
    .map((e) => ({ ...e, guidance: NOT_SEARCHED_GUIDANCE[e.reason] }));
}

/** The reason for a table stored on a case as not searched. */
export function dsarNotSearchedOf(
  table: string,
  memberScoped: Readonly<Record<string, string>> = DSAR_MEMBER_SCOPED_TABLES,
): DsarNotSearched {
  const reason: DsarNotSearchedReason =
    table in memberScoped ? "member_scoped" : "no_subject_column";
  return { table, reason, guidance: NOT_SEARCHED_GUIDANCE[reason] };
}
