/**
 * Local SQLite queries for the People list and person record. They run against the PowerSync views
 * on the device, so they work with no network once synced. Every query is scoped to the signed-in
 * tenant as a client-side assertion on top of the server's sync streams (section 5.3).
 */

/** Allergy row statuses that do not count as an active allergy (FHIR clinical and verification). */
export const INACTIVE_ALLERGY_STATUSES = [
  "inactive",
  "resolved",
  "refuted",
  "entered-in-error",
] as const;

/** A missing status counts as active: an allergy is never hidden because a field is empty. */
export function isActiveAllergyStatus(status: string | null | undefined): boolean {
  const value = (status ?? "active").trim().toLowerCase();
  return !(INACTIVE_ALLERGY_STATUSES as readonly string[]).includes(value);
}

const inactivePlaceholders = INACTIVE_ALLERGY_STATUSES.map(() => "?").join(", ");

const PERSON_COLUMNS = `
  p.id,
  p.preferred_name,
  p.given_name,
  p.family_name,
  p.room_label,
  p.photo_document_id,
  p.communication_needs,
  p.allergy_status,
  p.date_of_birth,
  p.nhs_number,
  (
    SELECT COUNT(*) FROM allergy a
    WHERE a.person_id = p.id
      AND a.tenant_id = p.tenant_id
      AND lower(trim(COALESCE(a.status, 'active'))) NOT IN (${inactivePlaceholders})
  ) AS allergy_count`;

/** Row shape returned by both queries. */
export interface PersonRow {
  readonly id: string;
  readonly preferred_name: string | null;
  readonly given_name: string | null;
  readonly family_name: string | null;
  readonly room_label: string | null;
  readonly photo_document_id: string | null;
  readonly communication_needs: string | null;
  readonly allergy_status: string | null;
  readonly date_of_birth: string | null;
  readonly nhs_number: string | null;
  readonly allergy_count: number;
}

export const PEOPLE_LIST_SQL = `SELECT ${PERSON_COLUMNS}
FROM person p
WHERE p.tenant_id = ?
ORDER BY p.family_name COLLATE NOCASE, p.given_name COLLATE NOCASE, p.id`;

export function peopleListParams(tenantId: string): string[] {
  return [...INACTIVE_ALLERGY_STATUSES, tenantId];
}

export const PERSON_SQL = `SELECT ${PERSON_COLUMNS}
FROM person p
WHERE p.tenant_id = ? AND p.id = ?`;

export function personParams(tenantId: string, personId: string): string[] {
  return [...INACTIVE_ALLERGY_STATUSES, tenantId, personId];
}

export interface AllergyRow {
  readonly id: string;
  readonly substance: string | null;
  readonly reaction: string | null;
  readonly severity: string | null;
  readonly status: string | null;
}

export const PERSON_ALLERGIES_SQL = `SELECT a.id, a.substance, a.reaction, a.severity, a.status
FROM allergy a
WHERE a.tenant_id = ? AND a.person_id = ?
  AND lower(trim(COALESCE(a.status, 'active'))) NOT IN (${inactivePlaceholders})
ORDER BY a.substance COLLATE NOCASE, a.id`;

export function personAllergiesParams(tenantId: string, personId: string): string[] {
  return [tenantId, personId, ...INACTIVE_ALLERGY_STATUSES];
}
