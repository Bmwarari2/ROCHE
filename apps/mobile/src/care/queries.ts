/**
 * Local SQLite queries for Care mode. They run against the PowerSync views on the device, so they
 * work with no network once synced. Every query is scoped to the signed-in tenant as a client-side
 * assertion on top of the sync streams, which decide what reaches the device (section 5.3).
 */
import type { AdvanceCareRow } from "./person-summary";

/** The person's location and status, for new entries. */
export const PERSON_CONTEXT_SQL = `SELECT p.location_id, p.status
FROM person p WHERE p.tenant_id = ? AND p.id = ?`;

export interface PersonContextRow {
  readonly location_id: string | null;
  readonly status: string | null;
}

/** The latest care profile row for a person. */
export const CARE_PROFILE_SQL = `SELECT cp.iddsi_food_level, cp.iddsi_drink_level, cp.fluid_target_ml,
  cp.spo2_scale2, cp.skin_risk
FROM person_care_profile cp
WHERE cp.tenant_id = ? AND cp.person_id = ?
ORDER BY cp.updated_at DESC, cp.id
LIMIT 1`;

export interface CareProfileRow {
  readonly iddsi_food_level: string | null;
  readonly iddsi_drink_level: string | null;
  readonly fluid_target_ml: number | null;
  readonly spo2_scale2: number | null;
  readonly skin_risk: string | null;
}

const ADVANCE_CARE_COLUMNS = `a.id, a.person_id, a.kind, a.status, a.cpr_decision, a.clinician_name,
  a.clinician_role, a.completed_on, a.review_due_on`;

/** Advance care records in force for one person (the streams send active ones only). */
export const PERSON_ADVANCE_CARE_SQL = `SELECT ${ADVANCE_CARE_COLUMNS}
FROM advance_care_record a
WHERE a.tenant_id = ? AND a.person_id = ?`;

/** Advance care records for everyone on the device, for the Today list. */
export const ALL_ADVANCE_CARE_SQL = `SELECT ${ADVANCE_CARE_COLUMNS}
FROM advance_care_record a
WHERE a.tenant_id = ?`;

export type { AdvanceCareRow };

/** Groups advance care rows by person. */
export function byPerson<T extends { readonly person_id?: string | null }>(
  rows: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.person_id) continue;
    const list = map.get(row.person_id) ?? [];
    list.push(row);
    map.set(row.person_id, list);
  }
  return map;
}

const ENTRY_COLUMNS = `id, occurred_at, recorded_at, device_time, late_entry, clock_drift,
  supersedes_id, correction_reason`;

export interface EntryRowBase {
  readonly id: string;
  readonly occurred_at: string;
  readonly recorded_at: string | null;
  readonly device_time: string | null;
  readonly late_entry: number | null;
  readonly clock_drift: number | null;
  readonly supersedes_id: string | null;
  readonly correction_reason: string | null;
}

/** Notes, newest first. */
export const NOTES_SQL = `SELECT ${ENTRY_COLUMNS}, category, body, tags
FROM care_note
WHERE tenant_id = ? AND person_id = ?
ORDER BY occurred_at DESC, id DESC
LIMIT 200`;

export interface NoteRow extends EntryRowBase {
  readonly category: string | null;
  readonly body: string | null;
  readonly tags: string | null;
}

/** One entry being corrected, by id, for the person in the tenant. */
export const NOTE_BY_ID_SQL = `SELECT ${ENTRY_COLUMNS}, category, body, tags
FROM care_note WHERE tenant_id = ? AND person_id = ? AND id = ?`;

export const OBSERVATION_BY_ID_SQL = `SELECT ${ENTRY_COLUMNS}, chart, chart_values, flags
FROM observation WHERE tenant_id = ? AND person_id = ? AND id = ?`;

export const MARK_BY_ID_SQL = `SELECT ${ENTRY_COLUMNS}, view, region, side, mark_type,
  pressure_category, status, description
FROM body_map_mark WHERE tenant_id = ? AND person_id = ? AND id = ?`;

/** Chart entries, newest first; pass the chart, or null for every chart. */
export const OBSERVATIONS_SQL = `SELECT ${ENTRY_COLUMNS}, chart, chart_values, flags
FROM observation
WHERE tenant_id = ? AND person_id = ? AND (? IS NULL OR chart = ?)
ORDER BY occurred_at DESC, id DESC
LIMIT 200`;

export function observationParams(tenantId: string, personId: string, chart: string | null) {
  return [tenantId, personId, chart, chart];
}

export interface ObservationRow extends EntryRowBase {
  readonly chart: string | null;
  readonly chart_values: string | null;
  readonly flags: string | null;
}

/** Body map marks, newest first. */
export const MARKS_SQL = `SELECT ${ENTRY_COLUMNS}, view, region, side, mark_type, pressure_category,
  status, description
FROM body_map_mark
WHERE tenant_id = ? AND person_id = ?
ORDER BY occurred_at DESC, id DESC
LIMIT 200`;

export interface MarkRow extends EntryRowBase {
  readonly view: string | null;
  readonly region: string | null;
  readonly side: string | null;
  readonly mark_type: string | null;
  readonly pressure_category: string | null;
  readonly status: string | null;
  readonly description: string | null;
}

/** The active care plan (the streams send no drafts). */
export const CARE_PLAN_SQL = `SELECT id, published_version, summary, review_due_on, published_at
FROM care_plan
WHERE tenant_id = ? AND person_id = ? AND status = 'active'
ORDER BY published_version DESC, id
LIMIT 1`;

export interface CarePlanRow {
  readonly id: string;
  readonly published_version: number | null;
  readonly summary: string | null;
  readonly review_due_on: string | null;
  readonly published_at: string | null;
}

export const PLAN_SECTIONS_SQL = `SELECT id, domain, need, outcome, strengths, contingency
FROM care_plan_section
WHERE tenant_id = ? AND plan_id = ?`;

export interface PlanSectionRow {
  readonly id: string;
  readonly domain: string | null;
  readonly need: string | null;
  readonly outcome: string | null;
  readonly strengths: string | null;
  readonly contingency: string | null;
}

export const PLAN_ACTIONS_SQL = `SELECT id, section_id, action, role_key, when_text
FROM care_plan_action
WHERE tenant_id = ? AND plan_id = ?
ORDER BY action COLLATE NOCASE, id`;

export interface PlanActionRow {
  readonly id: string;
  readonly section_id: string | null;
  readonly action: string | null;
  readonly role_key: string | null;
  readonly when_text: string | null;
}

/** Active risk assessments, soonest review first. */
export const RISKS_SQL = `SELECT id, template_key, hazard, who_at_risk, risk_rating, risk_band,
  residual_rating, residual_band, controls, positive_risk_statement, person_views, assessed_on,
  review_due_on
FROM risk_assessment
WHERE tenant_id = ? AND person_id = ? AND status = 'active'
ORDER BY review_due_on, id`;

export interface RiskRow {
  readonly id: string;
  readonly template_key: string | null;
  readonly hazard: string | null;
  readonly who_at_risk: string | null;
  readonly risk_rating: number | null;
  readonly risk_band: string | null;
  readonly residual_rating: number | null;
  readonly residual_band: string | null;
  readonly controls: string | null;
  readonly positive_risk_statement: string | null;
  readonly person_views: string | null;
  readonly assessed_on: string | null;
  readonly review_due_on: string | null;
}

/** Validated-tool results, newest first; the screen keeps the latest per tool. */
export const ASSESSMENTS_SQL = `SELECT id, tool_key, score, band, occurred_at, next_due_on,
  supersedes_id
FROM assessment
WHERE tenant_id = ? AND person_id = ?
ORDER BY occurred_at DESC, id DESC`;

export interface AssessmentRow {
  readonly id: string;
  readonly tool_key: string | null;
  readonly score: number | null;
  readonly band: string | null;
  readonly occurred_at: string | null;
  readonly next_due_on: string | null;
  readonly supersedes_id: string | null;
}

/** Entries the server refused, kept on the device until dealt with. */
export const UPLOAD_ISSUES_SQL = `SELECT i.id, i.person_id, i.record_table, i.http_status, i.code,
  i.message, i.payload, i.rejected_at, p.preferred_name, p.given_name, p.family_name
FROM upload_issue i
LEFT JOIN person p ON p.id = i.person_id AND p.tenant_id = i.tenant_id
WHERE i.tenant_id = ?
ORDER BY i.rejected_at DESC, i.id`;

export interface UploadIssueRow {
  readonly id: string;
  readonly person_id: string | null;
  readonly record_table: string | null;
  readonly http_status: number | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly payload: string | null;
  readonly rejected_at: string | null;
  readonly preferred_name: string | null;
  readonly given_name: string | null;
  readonly family_name: string | null;
}

export const DELETE_UPLOAD_ISSUE_SQL = "DELETE FROM upload_issue WHERE tenant_id = ? AND id = ?";
