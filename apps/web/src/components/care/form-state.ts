"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { uuidv7 } from "@/lib/entry-id";

/**
 * Stable ids for a form's fields, so the error summary can link to each one and move focus to
 * it. `ids.side` is the id to give the side question; keys are the form's field names.
 */
export function useFieldIds<K extends string>(keys: readonly K[]): Readonly<Record<K, string>> {
  const base = useId();
  const prefix = useMemo(() => {
    let safe = "";
    for (const char of base) {
      const code = char.charCodeAt(0);
      const keep =
        (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (keep) safe += char;
    }
    return `f${safe}`;
  }, [base]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys are a literal list per form; joining them keeps the ids stable between renders.
  return useMemo(
    () => Object.fromEntries(keys.map((key) => [key, `${prefix}-${key}`])) as Record<K, string>,
    [prefix, keys.join("|")],
  );
}

/**
 * A form that opens in place from a button (correct a note, withdraw a record, close a risk
 * assessment). Opening moves focus to its first field; closing it with Cancel puts focus back on
 * the button that opened it (WCAG 2.4.3), so keyboard and screen reader users never lose their
 * place.
 */
export function useInlineForm<F extends HTMLElement>() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstField = useRef<F>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (open) {
      firstField.current?.focus();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => {
    restoreFocus.current = true;
    setOpen(false);
  }, []);
  return { open, show, hide, trigger, firstField };
}

/**
 * The id of the entry a form is writing (hazard HZ-029). The same id goes with every attempt until
 * the entry is saved, so retrying after a lost connection never records it twice; `next` starts a
 * new entry once it is saved.
 */
export function useEntryId(): { readonly id: string; readonly next: () => void } {
  const [id, setId] = useState(() => uuidv7());
  const next = useCallback(() => setId(uuidv7()), []);
  return { id, next };
}
