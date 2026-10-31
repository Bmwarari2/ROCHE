import { stripInternalParams } from "../platform/link-params";

/**
 * Every link that opens the app from outside (`harbour://`, the system's own launch) passes here
 * first: the parameters only the app's own navigation may set are removed (#123 security review,
 * M2). On any failure the app opens at its start, never at the link as it came.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return stripInternalParams(path);
  } catch {
    return "/";
  }
}
