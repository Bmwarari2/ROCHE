/**
 * What a quality form did, for the page's address: the page says it when it opens again
 * (quality.md section 16). Shared by the client forms and the server pages.
 */
export const QUALITY_DONE = [
  "composed",
  "added",
  "redacted",
  "released",
  "reissued",
  "revoked",
  "discarded",
  "drafted",
  "saved",
  "approved",
  "sopDiscarded",
  "notified",
  "mapped",
  "tagged",
  "untagged",
  "templateAdded",
  "templateRetired",
  "scheduled",
  "answered",
  "started",
  "auditCompleted",
] as const;
export type QualityDone = (typeof QUALITY_DONE)[number];

/** The `done` value from a page's address, when it is one of these. */
export function qualityDone(value: string | string[] | undefined): QualityDone | null {
  return typeof value === "string" && (QUALITY_DONE as readonly string[]).includes(value)
    ? (value as QualityDone)
    : null;
}
