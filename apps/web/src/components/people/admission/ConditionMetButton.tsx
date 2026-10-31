"use client";

import { Button } from "@harbour/ui";
import { CircleCheck } from "lucide-react";
import { confirmCondition } from "@/app/actions/admission";
import { FormFeedback } from "@/components/care/FormFeedback";
import { t } from "@/lib/i18n";
import { useActionForm } from "./action-form";

/**
 * Confirms that one condition of the decision to admit has been met (people.md rule 5;
 * people.admission.manage). Admission waits until every condition is confirmed. The button names
 * the condition, so each one on the page is told apart.
 */
export function ConditionMetButton({
  personId,
  decisionId,
  conditionId,
  version,
  number,
  met,
}: {
  readonly personId: string;
  readonly decisionId: string;
  readonly conditionId: string;
  readonly version: number;
  readonly number: number;
  /** Already confirmed: the button goes, and the words of a confirmation just made stay. */
  readonly met: boolean;
}) {
  const form = useActionForm();
  return (
    <div className="flex flex-col gap-2">
      {met ? null : (
        <div>
          <Button
            variant="secondary"
            icon={<CircleCheck size={16} strokeWidth={1.5} />}
            disabled={form.pending}
            onClick={() =>
              form.run(() => confirmCondition(personId, decisionId, conditionId, version))
            }
          >
            {t("people.decision.condition.confirm", { n: number })}
          </Button>
        </div>
      )}
      <FormFeedback result={form.result} success={t("people.decision.condition.confirmed")} />
    </div>
  );
}
