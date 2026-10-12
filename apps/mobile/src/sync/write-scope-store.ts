import { useEffect, useSyncExternalStore } from "react";
import { deletePlain, readPlain, WRITE_SCOPE_ITEM, writePlain } from "../platform/secure-store";
import { parseStoredWriteScope, serialiseWriteScope, type WriteScope } from "./write-scope";

/**
 * The phone's current write scope (`write-scope.ts`): set from each sync token, kept in the
 * keystore's plain items so it is known again after a restart while offline, and cleared when the
 * session ends. Null while none is known: none stored, or one that could not be kept or read. The
 * phone then records about no one, and the person screen says so (review rounds 4 and 5).
 */
let current: WriteScope | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Logs a keystore failure by the item's name and the error's kind only, never the scope. */
function logFailure(message: string, error: unknown): void {
  console.warn(message, {
    item: WRITE_SCOPE_ITEM,
    error: error instanceof Error ? error.name : "Error",
  });
}

/**
 * Removes the stored scope. When it cannot be removed, the failure is logged and the item is
 * overwritten with a value that names no scope, so a restart finds none rather than an older,
 * wider one; when that fails too, it is logged again (review round 5). Never throws.
 */
async function forgetStored(): Promise<void> {
  try {
    await deletePlain(WRITE_SCOPE_ITEM);
  } catch (error) {
    logFailure("write scope could not be removed", error);
    try {
      await writePlain(WRITE_SCOPE_ITEM, "null");
    } catch (again) {
      logFailure("write scope could not be overwritten", again);
    }
  }
}

/**
 * Takes the scope a new sync token carries (null when it carries none: nothing changes). When it
 * cannot be kept, the failure is logged (the item's name and the error's kind, never the scope),
 * the stored one is removed, and the phone records about no one until a token's scope is kept, so
 * neither now nor after a restart does it fall back to an older, wider scope (review rounds 4
 * and 5).
 */
export async function setWriteScope(scope: WriteScope | null): Promise<void> {
  if (scope === null) return;
  current = scope;
  loaded = true;
  emit();
  try {
    await writePlain(WRITE_SCOPE_ITEM, serialiseWriteScope(scope));
  } catch (error) {
    logFailure("write scope could not be stored", error);
    if (current === scope) {
      current = null;
      emit();
    }
    await forgetStored();
  }
}

/** The scope in force now (for tests and the person screen's first render). */
export function currentWriteScope(): WriteScope | null {
  return current;
}

/** Forgets the scope when the session ends; a keystore failure is logged, never thrown. */
export async function clearWriteScope(): Promise<void> {
  current = null;
  loaded = true;
  emit();
  await forgetStored();
}

/**
 * Reads the stored scope once (the person screen does on its first render); one that cannot be
 * read leaves none known, so the phone records about no one (fails closed). Returns the scope in
 * force.
 */
export async function loadWriteScope(): Promise<WriteScope | null> {
  if (loaded) return current;
  loaded = true;
  let stored: WriteScope | null = null;
  try {
    stored = parseStoredWriteScope(await readPlain(WRITE_SCOPE_ITEM));
  } catch (error) {
    logFailure("write scope could not be read", error);
  }
  if (stored !== null && current === null) {
    current = stored;
    emit();
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): WriteScope | null => current;

/** The current write scope, or null while none is known. */
export function useWriteScope(): WriteScope | null {
  useEffect(() => {
    void loadWriteScope();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
