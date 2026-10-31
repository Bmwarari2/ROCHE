"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/outcome";

/**
 * The state of one admission or property form: the last result (shown by FormFeedback, which
 * moves focus to the problem summary or the success words) and whether it is being sent. A
 * successful send runs `onOk`, for example to close an inline form or start a new entry; the
 * server action has already asked the page to read the record again.
 */
export function useActionForm() {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const run = <T>(send: () => Promise<ActionResult<T>>, onOk?: (data: T) => void) =>
    startTransition(async () => {
      const outcome = await send();
      setResult(outcome);
      if (outcome.ok) onOk?.(outcome.data);
    });
  return { result, setResult, pending, run };
}

export type ActionForm = ReturnType<typeof useActionForm>;
