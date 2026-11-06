"use client";

import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { type ActionResult, collectedRefusal, type FieldProblem } from "@/lib/outcome";

type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: FieldProblem[] };

/**
 * The shared submit of the staff screens' forms: read the fields (every problem at once, WCAG
 * 3.3.1) and send through the server action. A refusal stays with the form. On success the page
 * opens again (or the new record's page) with `?done=`, and the page says what was done in a
 * polite status with focus on its heading (RecordedArrival): forms that leave the page once saved
 * (marked reported, acknowledged) cannot take the message with them (review M1).
 */
export function useStaffForm<T, R>(
  read: (form: FormData) => Read<T>,
  send: (value: T) => Promise<ActionResult<R>>,
  options: { readonly done: string; readonly to?: (data: R) => string },
) {
  const router = useRouter();
  const pathname = usePathname();
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
      if (!outcome.ok) {
        setResult(outcome);
        return;
      }
      setResult(null);
      form.reset();
      const path = options.to ? options.to(outcome.data) : pathname;
      router.replace(`${path}?done=${options.done}&at=${Date.now()}`, { scroll: false });
    });
  };
  return { result, pending, submit };
}
