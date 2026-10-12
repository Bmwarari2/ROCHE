"use client";

import { Button } from "@harbour/ui";
import { FilePlus2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { startCarePlanDraft } from "@/app/actions/care-plan";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { useEntryId } from "./form-state";

/** Starts a draft (from the plan in use, when there is one) and opens it for editing. */
export function StartDraftButton({
  personId,
  label,
}: {
  readonly personId: string;
  readonly label: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  // The draft's client id, kept across retries of the same press (HZ-029).
  const entry = useEntryId();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          icon={<FilePlus2 size={18} strokeWidth={1.5} />}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const outcome = await startCarePlanDraft(personId, entry.id);
              setResult(outcome);
              if (outcome.ok) {
                entry.next();
                router.push(`/people/${personId}/care-plan/${outcome.data.id}`);
              }
            })
          }
        >
          {pending ? t("common.saving") : label}
        </Button>
      </div>
      <FormFeedback result={result} success={t("care.plan.started")} />
    </div>
  );
}
