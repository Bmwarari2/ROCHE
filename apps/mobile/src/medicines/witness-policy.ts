/**
 * The controlled drugs witness policy at a person's home, by the API's own rule
 * (`witnessPolicyForServices`, medicines.md rule 27): the strictest of the home's active services,
 * `required` when the phone knows none. The phone offers "no one is here to witness" only under
 * `where_available`, so a lone worker is never let record a dose the register then refuses after it
 * was given (HZ-116). When the phone knows no service for the home it says so, rather than stating
 * a rule it has not seen.
 */
import { type CdWitnessPolicy, witnessPolicyForServices } from "@harbour/domain";

/** The active services of the home the person lives at, from `my_location_services`. */
export const WITNESS_SERVICES_SQL = `
SELECT s.service_type
FROM location_service s
JOIN person p ON p.location_id = s.location_id AND p.tenant_id = s.tenant_id
WHERE p.id = ? AND s.status = 'active'`;

export interface PhoneWitnessPolicy {
  readonly policy: CdWitnessPolicy;
  /** Whether the phone holds any service for the home: false says "not known yet", not a rule. */
  readonly known: boolean;
}

export function phoneWitnessPolicy(
  services: readonly { readonly service_type: string | null }[],
): PhoneWitnessPolicy {
  return {
    policy: witnessPolicyForServices(services.map((s) => s.service_type)),
    known: services.length > 0,
  };
}
