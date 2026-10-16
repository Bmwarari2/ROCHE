import { InvitationLookup } from "@harbour/contracts";
import { formatDateTime } from "./format";
import { asRefusal, type LookupResult } from "./invitations";

/**
 * What the page is told about a lookup the API answered: only what the contract allows reaches it
 * (#59 review round 2); anything else reads as unavailable.
 */
export function lookupResultFrom(body: unknown): LookupResult {
  const parsed = InvitationLookup.safeParse(body);
  if (!parsed.success) return { kind: "unavailable" };
  const data = parsed.data;
  if (data.refusal) return { kind: "refused", refusal: asRefusal(data.refusal) };
  return {
    kind: "found",
    organisationName: data.organisationName,
    emailMasked: data.emailMasked,
    expiresAt: formatDateTime(data.expiresAt) ?? "",
    path: data.path,
  };
}
