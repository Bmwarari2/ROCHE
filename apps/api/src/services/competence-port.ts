import { competenceSignOff, competenceWithdrawal, type Transaction } from "@harbour/db";
import {
  type Competence,
  type CompetenceDecision,
  competenceDecision,
  type StoredSignOff,
  ukIsoDate,
} from "@harbour/domain";
import { and, eq } from "drizzle-orm";
import { withSystemRights } from "./system-rights";

/**
 * The competence port (ADR-0085; workforce.md section 5; hazards HZ-119 and HZ-124). Medicines and
 * scheduling call it on the server to decide whether a member may do an action needing a
 * competence at an instant; it never takes a competence from the client. It reads that member's
 * sign-offs and withdrawals for that one competence with the system's rights, because the caller
 * (a care worker giving medicines, a rota planner) may not read training records, and answers with
 * dates only. The calling module records the check with its own action.
 */
export async function competencePort(
  tx: Transaction,
  memberId: string,
  competence: Competence,
  at: Date,
): Promise<CompetenceDecision> {
  const signOffs = await memberSignOffs(tx, memberId, competence);
  return competenceDecision(signOffs, ukIsoDate(at));
}

/** One member's stored sign-offs for one competence, with their withdrawals (system rights). */
export function memberSignOffs(
  tx: Transaction,
  memberId: string,
  competence: Competence,
): Promise<StoredSignOff[]> {
  return withSystemRights(tx, async () => {
    const rows = await tx
      .select({
        observedOn: competenceSignOff.observedOn,
        validUntil: competenceSignOff.validUntil,
        withdrawnAt: competenceWithdrawal.createdAt,
      })
      .from(competenceSignOff)
      .leftJoin(competenceWithdrawal, eq(competenceWithdrawal.signOffId, competenceSignOff.id))
      .where(
        and(eq(competenceSignOff.workerId, memberId), eq(competenceSignOff.competence, competence)),
      );
    return rows.map((r) => ({
      observedOn: r.observedOn,
      validUntil: r.validUntil,
      withdrawnOn: r.withdrawnAt ? ukIsoDate(r.withdrawnAt) : null,
    }));
  });
}
