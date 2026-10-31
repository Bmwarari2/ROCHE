"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/outcome";

export type FormRead<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

/**
 * One form's submit for the slice 62 screens: the form is read and checked here first (errors at
 * each field and in a summary that takes focus), then sent to its server action; on success the
 * page refreshes from the API and `onDone` runs (for example to clear the form or go elsewhere).
 */
export function useSubmit<T, R>(
  read: (form: FormData) => FormRead<T>,
  act: (body: T) => Promise<ActionResult<R>>,
  onDone?: (data: R, form: HTMLFormElement) => void,
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
      }
    });
  };
  return { submit, result, pending };
}
