/**
 * Separation of duties the regulator expects (section 4, implementation rules):
 * - two distinct users for controlled-drug administration (administer and witness);
 * - two distinct users for residents' money transactions above the tenant's limit;
 * - the person who records an incident cannot close it;
 * - the person who records a ledger transaction cannot approve it (section 14 rules);
 * - the person who prepared a DPIA cannot sign it off (platform-completions.md rule 21).
 */

export type DutyRule =
  | "controlled_drug_witness"
  | "residents_money_second_signature"
  | "incident_close"
  | "ledger_approval"
  | "dpia_sign_off";

export const DUTY_RULE_MESSAGES: Record<DutyRule, string> = {
  controlled_drug_witness: "The witness must be a different person from the one giving the dose.",
  residents_money_second_signature:
    "A second person must sign for this amount. You cannot sign twice.",
  incident_close: "Someone other than the person who reported this incident must close it.",
  ledger_approval: "Someone other than the person who recorded this transaction must approve it.",
  dpia_sign_off: "Someone other than the people who prepared this DPIA must sign it off.",
};

export type DutyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: DutyRule; readonly message: string };

export function checkDistinctActors(
  rule: DutyRule,
  firstActorId: string,
  secondActorId: string | null | undefined,
): DutyCheck {
  if (!secondActorId || secondActorId === firstActorId) {
    return { ok: false, rule, message: DUTY_RULE_MESSAGES[rule] };
  }
  return { ok: true };
}
