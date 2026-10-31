/**
 * Query parameters a link from outside the app may never carry (#123 security review, M2). `task`
 * tags new entries with a round's task, and `taskTitle` was once shown as text: both are set only
 * by the app's own navigation, never by a `harbour://` link from another app, a web page or a
 * message. The screens also check a task against the device (`useRoundTaskFor`); this keeps a
 * crafted link from even asking.
 */
export const INTERNAL_ONLY_PARAMS: readonly string[] = ["task", "taskTitle"];

/**
 * The path with the internal-only parameters removed, whatever its form: a path
 * (`/people/1/note?task=x`) or a full link (`harbour:///people/1/note?task=x#y`). A path with
 * none is returned as it came.
 */
export function stripInternalParams(path: string): string {
  const hashAt = path.indexOf("#");
  const hash = hashAt >= 0 ? path.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? path.slice(0, hashAt) : path;
  const queryAt = beforeHash.indexOf("?");
  if (queryAt < 0) return path;
  const base = beforeHash.slice(0, queryAt);
  const query = new URLSearchParams(beforeHash.slice(queryAt + 1));
  let removed = false;
  for (const name of [...query.keys()]) {
    if (INTERNAL_ONLY_PARAMS.includes(name)) {
      query.delete(name);
      removed = true;
    }
  }
  if (!removed) return path;
  const rest = query.toString();
  return `${base}${rest ? `?${rest}` : ""}${hash}`;
}
