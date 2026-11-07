/**
 * The controlled drugs witness policy at a person's home, as the API decides it (medicines.md rule
 * 27; `witnessPolicyFor`): the strictest among the home's active services, and `required` when the
 * phone knows none. The phone offers "no one is here to witness" only under `where_available`, so a
 * lone worker is never let record a dose the register then refuses after it was given (HZ-116).
 */
import { type CdWitnessPolicy, defaultCdWitnessPolicy, type ServiceType } from "@harbour/domain";

/** The active services of the home the person lives at, from `my_location_services`. */
export const WITNESS_SERVICES_SQL = `
SELECT s.service_type
FROM location_service s
JOIN person p ON p.location_id = s.location_id AND p.tenant_id = s.tenant_id
WHERE p.id = ? AND s.status = 'active'`;

const SERVICE_TYPES: ReadonlySet<string> = new Set<ServiceType>([
  "residential",
  "nursing",
  "supported_living",
  "domiciliary",
  "complex_care",
  "live_in",
  "respite",
  "day_service",
  "childrens_home",
]);

export function phoneWitnessPolicy(
  services: readonly { readonly service_type: string | null }[],
): CdWitnessPolicy {
  if (services.length === 0) return "required";
  // A service type the phone does not know counts as one that needs a witness.
  return services.every(
    (s) =>
      s.service_type !== null &&
      SERVICE_TYPES.has(s.service_type) &&
      defaultCdWitnessPolicy(s.service_type as ServiceType) === "where_available",
  )
    ? "where_available"
    : "required";
}
