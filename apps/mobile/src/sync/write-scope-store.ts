import { useEffect, useSyncExternalStore } from "react";
import { deletePlain, readPlain, WRITE_SCOPE_ITEM, writePlain } from "../platform/secure-store";
import {
  NO_WRITE_SCOPE,
  parseStoredWriteScope,
  serialiseWriteScope,
  type WriteScope,
} from "./write-scope";

/**
 * The phone's current write scope (`write-scope.ts`): set from each sync token, kept in the
 * keystore's plain items so it is known again after a restart while offline, and cleared when the
 * session ends.
 */
let current: WriteScope | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Takes the scope a new sync token carries (null when it carries none: nothing changes). When it
 * cannot be kept, the failure is logged (the item's name and the error's kind, never the scope)
 * and the phone records about no one until the next token, so a restart never falls back to an
 * older, wider scope (review round 4).
 */
export async function setWriteScope(scope: WriteScope | null): Promise<void> {
  if (scope === null) return;
  current = scope;
  loaded = true;
  emit();
  try {
    await writePlain(WRITE_SCOPE_ITEM, serialiseWriteScope(scope));
  } catch (error) {
    console.warn("write scope could not be stored", {
      item: WRITE_SCOPE_ITEM,
      error: error instanceof Error ? error.name : "Error",
    });
    if (current === scope) {
      current = NO_WRITE_SCOPE;
      emit();
    }
    await deletePlain(WRITE_SCOPE_ITEM).catch(() => undefined);
  }
}

/** The scope in force now (for tests and the person screen's first render). */
export function currentWriteScope(): WriteScope | null {
  return current;
}

/** Forgets the scope when the session ends. */
export async function clearWriteScope(): Promise<void> {
  current = null;
  loaded = true;
  emit();
  await deletePlain(WRITE_SCOPE_ITEM);
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const stored = parseStoredWriteScope(await readPlain(WRITE_SCOPE_ITEM));
  if (stored !== null && current === null) {
    current = stored;
    emit();
  }
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
    void load();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
