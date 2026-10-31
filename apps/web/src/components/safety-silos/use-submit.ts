"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/outcome";
import { SILO_STATUS_ID } from "./silo-status-id";

export type FormRead<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

/**
 * Says what happened in the page's status region and moves focus to the page heading: used when
 * the form that succeeded is replaced by the refresh (a step that is no longer offered), so focus
 * never drops to the page body unannounced (WCAG 2.4.3, 4.1.3).
 */
export function announceAndRefocus(message: string) {
  const region = document.getElementById(SILO_STATUS_ID);
  if (region) region.textContent = message;
  window.setTimeout(() => {
    const heading = document.querySelector<HTMLElement>("main h1");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.focus();
  }, 300);
}

/**
 * One form's submit for the slice 62 screens: the form is read and checked here first (errors at
 * each field and in a summary that takes focus), then sent to its server action; on success the
 * page refreshes from the API and `onDone` runs (for example to clear the form or go elsewhere).
 */
export function useSubmit<T, R>(
  read: (form: FormData) => FormRead<T>,
  act: (body: T) => Promise<ActionResult<R>>,
  onDone?: (data: R, form: HTMLFormElement) => void,
  /** For a form the refresh replaces: announce this and move focus to the page heading. */
  replacedWith?: string,
) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const parsed = read(new FormData(element));
    if (!parsed.ok) {
      const [first] = Object.values(parsed.errors);
      setResult({
        ok: false,
        code: "invalid",
        message: first ?? "",
        fields: parsed.errors,
        ...(parsed.parts ? { parts: parsed.parts } : {}),
      });
      return;
    }
    startTransition(async () => {
      const outcome = await act(parsed.body);
      setResult(outcome);
      if (outcome.ok) {
        onDone?.(outcome.data, element);
        router.refresh();
        if (replacedWith) announceAndRefocus(replacedWith);
      }
    });
  };
  return { submit, result, pending };
}
