"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { type ActionResult, collectedRefusal, type FieldProblem } from "@/lib/outcome";

type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: FieldProblem[] };

/**
 * The shared submit of the staff screens' forms: read the fields (every problem at once, WCAG
 * 3.3.1), send through the server action, and on success refresh the page so its status shows
 * what was done. `after` runs on success (to move to a new record, or reset the form).
 */
export function useStaffForm<T, R>(
  read: (form: FormData) => Read<T>,
  send: (value: T) => Promise<ActionResult<R>>,
  after?: (data: R, form: HTMLFormElement) => void,
) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const got = read(new FormData(form));
    if (!got.ok) {
      setResult(collectedRefusal(got.problems));
      return;
    }
    startTransition(async () => {
      const outcome = await send(got.value);
      setResult(outcome);
      if (outcome.ok) {
        if (after) after(outcome.data, form);
        router.refresh();
      }
    });
  };
  return { result, pending, submit };
}
