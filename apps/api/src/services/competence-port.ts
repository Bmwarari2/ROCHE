import { competenceSignOff, competenceWithdrawal, type Transaction } from "@harbour/db";
import {
  type Competence,
  type CompetenceDecision,
  competenceDecisionAt,
  type StoredSignOff,
  ukIsoDate,
} from "@harbour/domain";
import { and, eq } from "drizzle-orm";
import { withSystemRights } from "./system-rights";

/**
 * The competence port (ADR-0085; workforce.md section 5; hazards HZ-119 and HZ-124). Medicines and
 * scheduling call it on the server to decide whether a member may do an action needing a
 * competence; it never takes a competence from the client, and the server's clock decides (a time
 * the device gives for an offline action is checked too, and can only block). It reads that member's
 * sign-offs and withdrawals for that one competence with the system's rights, because the caller
 * (a care worker giving medicines, a rota planner) may not read training records, and answers with
 * dates only. The calling module records the check with its own action.
 */
export async function competencePort(
  tx: Transaction,
  memberId: string,
  competence: Competence,
  claimedAt: Date | null = null,
  serverNow: Date = new Date(),
): Promise<CompetenceDecision> {
  const signOffs = await memberSignOffs(tx, memberId, competence);
  // The server's time always decides; a time the device gives can only block, never allow
  // (clinical safety review round 1, finding 2).
  return competenceDecisionAt(
    signOffs,
    ukIsoDate(serverNow),
    claimedAt ? ukIsoDate(claimedAt) : null,
  );
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
