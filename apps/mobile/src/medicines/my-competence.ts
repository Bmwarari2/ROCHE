/**
 * The member's own medicines competence on the phone (HZ-119; medicines.md rules 21 and 22), from
 * their synced sign-offs and withdrawals (`my_medicines_competence`), by the domain's own rule,
 * `competenceDecision` (clinical review round 1, finding 1): a withdrawal is about the member from
 * its UK day, so only a sign-off observed on or after it counts, and the newest sign-off in force
 * allows medicines through its valid-until day. So a lapsed, withdrawn or missing competence stops
 * a dose before it is given (guides review of the phone, 08/11/2026). An override cannot be seen
 * on the phone: a lapsed competence is sent to the web, where an override recorded by a manager
 * applies. The API's medicines port must read the same sign-offs (H-1532).
 */
import { competenceDecision, type StoredSignOff, ukIsoDate } from "@harbour/domain";

export const MY_COMPETENCE_SQL = `
SELECT s.id, s.observed_on, s.valid_until,
  (SELECT w.created_at FROM competence_withdrawal w
    WHERE w.sign_off_id = s.id AND w.tenant_id = s.tenant_id) AS withdrawn_at
FROM competence_sign_off s
WHERE s.tenant_id = ? AND s.worker_id = ? AND s.competence = 'medicines_administration'`;

export interface CompetenceRow {
  readonly id: string;
  readonly observed_on: string | null;
  readonly valid_until: string | null;
  readonly withdrawn_at: string | null;
}

export type PhoneCompetence = "current" | "expired" | "withdrawn" | "not_held" | "unknown";

const DATE = /^\d{4}-\d{2}-\d{2}/;

export function phoneCompetence(rows: readonly CompetenceRow[], at: Date): PhoneCompetence {
  const signOffs: StoredSignOff[] = [];
  for (const r of rows) {
    if (
      !r.observed_on ||
      !DATE.test(r.observed_on) ||
      !r.valid_until ||
      !DATE.test(r.valid_until)
    ) {
      continue;
    }
    const withdrawn = r.withdrawn_at ? new Date(r.withdrawn_at) : null;
    signOffs.push({
      observedOn: r.observed_on.slice(0, 10),
      validUntil: r.valid_until.slice(0, 10),
      withdrawnOn: withdrawn && !Number.isNaN(withdrawn.getTime()) ? ukIsoDate(withdrawn) : null,
    });
  }
  const decision = competenceDecision(signOffs, ukIsoDate(at));
  if (decision.allowed) return "current";
  return decision.reason === "missing" ? "not_held" : decision.reason;
}
