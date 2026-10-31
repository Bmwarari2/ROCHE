/**
 * Record history helpers shared by the person's history and a care record's history. The API sends
 * which fields the latest change altered, never the current row itself: the reader opens the record
 * through its own route, under that route's permission (security review round 1, data minimisation).
 */

/** Two stored (jsonb) values are the same, whatever the order of an object's keys. */
export function sameStored(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameStored(left[key], right[key]))
  );
}

/**
 * The keys of the newest stored version whose value differs in the row as it is now, sorted:
 * empty when there is no earlier version. A key the current row no longer has (a dropped column)
 * counts as unchanged. Null when the row is not the version straight after the newest stored one,
 * which happens only when a save landed between reading the versions and reading the row: then
 * nothing is compared rather than the wrong pair (clinical safety review round 1, L1). The version
 * trigger (`app.touch_mutable`) adds one to `version` on every update.
 */
export function latestChanged(
  versions: readonly {
    readonly version: number;
    readonly data: Readonly<Record<string, unknown>>;
  }[],
  current: Readonly<Record<string, unknown>> | undefined,
): string[] | null {
  const newest = versions.at(-1);
  if (!newest) return [];
  if (!current || current.version !== newest.version + 1) return null;
  return Object.keys(newest.data)
    .filter((key) => Object.hasOwn(current, key) && !sameStored(newest.data[key], current[key]))
    .sort();
}
