"use client";

import { Button } from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { answerIncidentQuestions } from "@/app/actions/incidents";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { type QuestionItem, questionField, readAnswers } from "@/lib/incident-forms";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { QuestionField } from "./QuestionField";

/**
 * The classifier's open questions on an incident that the viewer may answer (safety.md section 4;
 * HZ-013): every one for a holder of `safety.incident.manage`, the point-of-care falls questions
 * for the person who raised it. Answer what is known; a blank question stays open. Saving
 * classifies the incident again, and the page shows the new questions and notifications.
 */
export function ClassifierQuestions({
  incidentId,
  questions,
}: {
  readonly incidentId: string;
  readonly questions: readonly QuestionItem[];
}) {
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(questions.map((q) => questionField(q.key)));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readAnswers(new FormData(event.currentTarget), questions, t);
    if (!read.ok) {
      setResult(fieldErrors(read.errors));
      return;
    }
    startTransition(async () => {
      setResult(await answerIncidentQuestions(incidentId, read.answers));
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {questions.length > 0 ? (
        // A new set of questions (after saving) is a new form, with nothing left ticked.
        <form
          method="post"
          key={questions.map((q) => q.key).join("|")}
          className="flex flex-col gap-6"
          onSubmit={submit}
          noValidate
          aria-labelledby="classifier-questions"
        >
          <div className="flex flex-col gap-1">
            <h3 id="classifier-questions" className="m-0 text-body font-semibold">
              {t("safety.questions.title")}
            </h3>
            <p className="m-0 max-w-prose text-body-dense text-text-secondary">
              {t("safety.questions.intro")}
            </p>
          </div>
          {questions.map((question) => {
            const field = questionField(question.key);
            return (
              <QuestionField
                key={question.key}
                question={question}
                id={ids[field] ?? field}
                error={errorFor(result, field)}
              />
            );
          })}
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("safety.questions.submit")}
            </Button>
          </div>
        </form>
      ) : null}
      <FormFeedback result={result} success={t("safety.questions.saved")} fieldIds={ids} />
    </div>
  );
}
