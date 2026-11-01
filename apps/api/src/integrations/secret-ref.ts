import { GCP_REGIONS } from "../config";

/**
 * Which Secret Manager secrets an organisation may name for its integration credentials (#164
 * security review, L3). Only a regional secret in this environment's own project, in europe-west2,
 * whose id carries the organisation's own prefix: `harbour_int_<tenant id>_<name>`, as SSO keys
 * use `harbour_sso_<tenant id>_<name>` (services/sso.ts). Neither part can hold `_`, so one
 * organisation's prefix never matches another's, and no organisation can name a platform secret,
 * an SSO key or another organisation's credential. IAM can confine the API to `harbour_int_`.
 */
const SECRET_REF =
  /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/([a-z0-9-]+)\/secrets\/harbour_int_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[a-z0-9][a-z0-9-]{0,62}(\/versions\/(latest|[1-9][0-9]*))?$/;

/** The shape alone, for the request schema: the project and organisation are checked per request. */
export const SECRET_REF_SHAPE = SECRET_REF;

/** Why this organisation may not name the secret, or null when it may. Never echoes the name. */
export function secretRefProblem(
  ref: string,
  expected: { readonly projectId: string | undefined; readonly tenantId: string },
): string | null {
  const match = SECRET_REF.exec(ref);
  if (!match) {
    return "The secret must be a Secret Manager secret named harbour_int_<organisation id>_<name>.";
  }
  if (!expected.projectId || match[1] !== expected.projectId) {
    return "The secret must be in this environment's Google Cloud project.";
  }
  if (!(GCP_REGIONS as readonly string[]).includes(match[2] ?? "")) {
    return "The secret must be a regional secret in europe-west2.";
  }
  if (match[3] !== expected.tenantId.toLowerCase()) {
    return "The secret must carry this organisation's own prefix.";
  }
  return null;
}

/**
 * The address part of a sender (`Name <a@b>` or `a@b`), lower-cased, or null when it is not one
 * address.
 */
function senderAddress(from: string): string | null {
  const angle = /<([^<>\s]+)>\s*$/.exec(from);
  const address = (angle?.[1] ?? from).trim().toLowerCase();
  return /^[^@\s<>,;]+@[a-z0-9.-]+$/.test(address) ? address : null;
}

/**
 * Whether a tenant's sender address is on a domain the platform allows (`SMTP_ALLOWED_FROM_DOMAINS`;
 * #164 security review, L2): the domain exactly, never a subdomain or a look-alike. With no
 * domains configured, nothing is allowed.
 */
export function senderAllowed(from: string, domains: readonly string[]): boolean {
  const address = senderAddress(from);
  if (!address) return false;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return domains.includes(domain);
}
