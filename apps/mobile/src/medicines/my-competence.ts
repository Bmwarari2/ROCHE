/**
 * The member's own medicines competence on the phone (HZ-119; medicines.md rules 21 and 22), from
 * their synced sign-offs and withdrawals (`my_medicines_competence`) and the rate table, by the
 * same rule as the API (`medicinesCompetenceAt`): the latest sign-off not withdrawn, current until
 * `competence.medicines.refresh_months` after it. So a lapsed or missing competence stops a dose
 * before it is given, not when it is refused on upload (guides review of the phone, 08/11/2026).
 * An override cannot be seen on the phone: a lapsed competence is sent to the web, where an
 * override recorded by a manager applies.
 */
import { type MedicinesRates, medicinesCompetenceAt } from "@harbour/domain";

export const MY_COMPETENCE_SQL = `
SELECT s.id, s.observed_on,
  EXISTS (SELECT 1 FROM competence_withdrawal w
    WHERE w.sign_off_id = s.id AND w.tenant_id = s.tenant_id) AS withdrawn
FROM competence_sign_off s
WHERE s.tenant_id = ? AND s.worker_id = ? AND s.competence = 'medicines_administration'`;

export interface CompetenceRow {
  readonly id: string;
  readonly observed_on: string | null;
  readonly withdrawn: number | boolean | null;
}

export type PhoneCompetence = "current" | "expired" | "not_held" | "unknown";

export function phoneCompetence(
  rows: readonly CompetenceRow[],
  at: Date,
  rates: Pick<MedicinesRates, "competenceRefreshMonths"> | null,
): PhoneCompetence {
  if (!rates) return "unknown";
  const dates = rows
    .filter((r) => !r.withdrawn && typeof r.observed_on === "string")
    .map((r) => (r.observed_on as string).slice(0, 10))
    .sort();
  const latest = dates.length > 0 ? (dates[dates.length - 1] as string) : null;
  return medicinesCompetenceAt(latest, at, rates).state;
}
