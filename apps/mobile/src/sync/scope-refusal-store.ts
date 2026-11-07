import { useSyncExternalStore } from "react";

/**
 * Whether the API refused this phone a sync token because the member's access reaches more homes
 * and people than a phone can hold offline (`sync_scope_too_large`, ADR-0134; HZ-138). The sync
 * banner then says so in words and what to do, instead of a bare "Sync failed". In memory only:
 * the next token request asks again, and a token that is given clears it.
 */
let refused = false;
const listeners = new Set<() => void>();

export const SCOPE_TOO_LARGE_CODE = "sync_scope_too_large";

export function setScopeRefused(value: boolean): void {
  if (refused === value) return;
  refused = value;
  for (const listener of listeners) listener();
}

export function scopeRefused(): boolean {
  return refused;
}

export function useScopeRefused(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => refused,
    () => false,
  );
}
