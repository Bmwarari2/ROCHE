"use client";

import { Button, DateTimeInput, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { Plus, RefreshCcw, Trash2 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { recordDecision } from "@/app/actions/admission";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import {
  CONDITION_MAX,
  MAX_CONDITIONS,
  MIN_DECISION_REASONS,
  readConditions,
} from "@/lib/admission";
import { characterCount, t } from "@/lib/i18n";
import { collectedRefusal, errorFor, type FieldProblem, partsFor } from "@/lib/outcome";
import {
  boxesOf,
  dateTimeLabels,
  readDateField,
  readDateTimeField,
  ukRepeatedTime,
} from "@/lib/uk-time";
import { useActionForm } from "./action-form";
import { DateField } from "./DateField";

type Answer = "yes" | "yes_with_conditions" | "no";

const FIELDS = [
  "correctionReason",
  "canMeetNeeds",
  "reasons",
  "conditions",
  "plannedAdmissionOn",
  "trialEndsOn",
  "toldWho",
  "toldAt",
] as const;

/**
 * The decision to admit (people.md rule 5; people.admission.manage): whether the home can meet
 * the person's needs, the reasons in a sentence or more, the conditions to be met before admission
 * when it is conditional, and who was told and when. Decisions are append-only: a change is a new
 * decision that replaces the one in force, with the reason it is replaced (shown struck through).
 */
export function DecisionForm({
  personId,
  replaces,
}: {
  readonly personId: string;
  /** The decision in force, when this one replaces it. */
  readonly replaces: string | null;
}) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLElement>();
  const ids = useFieldIds(FIELDS);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [round, setRound] = useState(0);
  const nextKey = useRef(1);
  const [conditions, setConditions] = useState<{ key: number; text: string }[]>([
    { key: 0, text: "" },
  ]);
  const open = replaces === null || inline.open;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const correctionReason = String(data.get("correctionReason") ?? "").trim();
    if (replaces && correctionReason.length < 3) {
      problems.push({
        field: "correctionReason",
        message: t("people.decision.form.correctionRequired"),
      });
    }
    if (!answer) {
      problems.push({ field: "canMeetNeeds", message: t("people.decision.form.answerRequired") });
    }
    const reasons = String(data.get("reasons") ?? "").trim();
    if (reasons.length < MIN_DECISION_REASONS) {
      problems.push({
        field: "reasons",
        message: t("people.decision.form.reasonsRequired", { min: MIN_DECISION_REASONS }),
      });
    }
    const listed = readConditions(conditions.map((c) => c.text));
    if (answer === "yes_with_conditions" && listed.length === 0) {
      problems.push({ field: "conditions", message: t("people.decision.form.conditionsRequired") });
    }
    const planned = readDateField(data, "plannedAdmissionOn", {
      subject: t("people.decision.form.plannedSubject"),
      optional: true,
      t,
    });
    if (!planned.ok) {
      problems.push({
        field: "plannedAdmissionOn",
        message: planned.message,
        parts: planned.parts,
      });
    }
    const trial = readDateField(data, "trialEndsOn", {
      subject: t("people.decision.form.trialSubject"),
      optional: true,
      t,
    });
    if (!trial.ok)
      problems.push({ field: "trialEndsOn", message: trial.message, parts: trial.parts });
    const toldWho = String(data.get("toldWho") ?? "").trim();
    const toldAt = readDateTimeField(data, "toldAt", {
      subject: t("people.decision.form.toldSubject"),
      optional: true,
      t,
    });
    if (!toldAt.ok)
      problems.push({ field: "toldAt", message: toldAt.message, parts: toldAt.parts });
    else if (Boolean(toldWho) !== Boolean(toldAt.instant)) {
      problems.push({
        field: toldWho ? "toldAt" : "toldWho",
        message: t("people.decision.form.toldBoth"),
      });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !answer || !planned.ok || !trial.ok || !toldAt.ok) {
      form.setResult(refusal);
      return;
    }
    form.run(
      () =>
        recordDecision(personId, {
          canMeetNeeds: answer,
          reasons,
          conditions: answer === "yes_with_conditions" ? listed : [],
          ...(planned.date ? { plannedAdmissionOn: planned.date } : {}),
          ...(trial.date ? { trialEndsOn: trial.date } : {}),
          ...(toldWho && toldAt.instant ? { toldWho, toldAt: toldAt.instant } : {}),
          ...(replaces ? { supersedesId: replaces, correctionReason } : {}),
        }),
      () => {
        setAnswer(null);
        setConditions([{ key: nextKey.current++, text: "" }]);
        setRound((n) => n + 1);
        inline.hide();
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {open ? (
        <form
          method="post"
          key={round}
          className="flex flex-col gap-4"
          onSubmit={submit}
          noValidate
        >
          {replaces ? (
            <TextArea
              id={ids.correctionReason}
              name="correctionReason"
              label={t("people.decision.form.correction")}
              hint={t("people.decision.form.correctionHint")}
              rows={2}
              required
              maxLength={500}
              formatCount={(remaining) => characterCount(remaining)}
              error={errorFor(form.result, "correctionReason")}
            />
          ) : null}
          <RadioGroup<Answer>
            id={ids.canMeetNeeds}
            name="canMeetNeeds"
            legend={t("people.decision.form.answer")}
            value={answer}
            onValueChange={setAnswer}
            required
            error={errorFor(form.result, "canMeetNeeds")}
            options={(["yes", "yes_with_conditions", "no"] as const).map((value) => ({
              value,
              label: t("people.decision.answer", { answer: value }),
              description: t("people.decision.form.answerHint", { answer: value }),
            }))}
          />
          <TextArea
            id={ids.reasons}
            name="reasons"
            label={t("people.decision.form.reasons")}
            hint={t("people.decision.form.reasonsHint", { min: MIN_DECISION_REASONS })}
            rows={4}
            required
            maxLength={4000}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(form.result, "reasons")}
          />
          {answer === "yes_with_conditions" ? (
            <fieldset
              id={ids.conditions}
              tabIndex={-1}
              className="m-0 flex flex-col gap-3 border-0 p-0"
              aria-describedby={
                errorFor(form.result, "conditions") ? `${ids.conditions}-error` : undefined
              }
            >
              <legend className="font-semibold">{t("people.decision.form.conditions")}</legend>
              <p className="m-0 text-text-secondary">{t("people.decision.form.conditionsHint")}</p>
              {errorFor(form.result, "conditions") ? (
                <p id={`${ids.conditions}-error`} className="hb-field__error m-0">
                  {errorFor(form.result, "conditions")}
                </p>
              ) : null}
              {conditions.map((condition, index) => (
                <div key={condition.key} className="flex flex-wrap items-end gap-2">
                  <TextField
                    label={t("people.decision.form.condition", { n: index + 1 })}
                    value={condition.text}
                    maxLength={CONDITION_MAX}
                    onChange={(e) =>
                      setConditions((current) =>
                        current.map((c) =>
                          c.key === condition.key ? { ...c, text: e.target.value } : c,
                        ),
                      )
                    }
                    className="min-w-0 flex-1"
                  />
                  {conditions.length > 1 ? (
                    <Button
                      variant="secondary"
                      icon={<Trash2 size={16} strokeWidth={1.5} />}
                      onClick={() =>
                        setConditions((current) => current.filter((c) => c.key !== condition.key))
                      }
                    >
                      {t("people.decision.form.removeCondition", { n: index + 1 })}
                    </Button>
                  ) : null}
                </div>
              ))}
              {conditions.length < MAX_CONDITIONS ? (
                <div>
                  <Button
                    variant="secondary"
                    icon={<Plus size={16} strokeWidth={1.5} />}
                    onClick={() =>
                      setConditions((current) => [...current, { key: nextKey.current++, text: "" }])
                    }
                  >
                    {t("people.decision.form.addCondition")}
                  </Button>
                </div>
              ) : null}
            </fieldset>
          ) : null}
          {answer !== "no" ? (
            <>
              <DateField
                id={ids.plannedAdmissionOn}
                name="plannedAdmissionOn"
                legend={t("people.decision.form.planned")}
                hint={t("people.decision.form.optionalDateHint")}
                result={form.result}
              />
              <DateField
                id={ids.trialEndsOn}
                name="trialEndsOn"
                legend={t("people.decision.form.trial")}
                hint={t("people.decision.form.trialHint")}
                result={form.result}
              />
            </>
          ) : null}
          <TextField
            id={ids.toldWho}
            name="toldWho"
            label={t("people.decision.form.toldWho")}
            hint={t("people.decision.form.toldWhoHint")}
            maxLength={200}
            error={errorFor(form.result, "toldWho")}
            className="max-w-md"
          />
          <DateTimeInput
            id={ids.toldAt}
            name="toldAt"
            legend={t("people.decision.form.toldAt")}
            hint={t("people.decision.form.toldAtHint")}
            labels={dateTimeLabels(t)}
            repeated={ukRepeatedTime}
            error={errorFor(form.result, "toldAt")}
            errorParts={boxesOf(partsFor(form.result, "toldAt"))}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={form.pending}>
              {form.pending ? t("common.saving") : t("people.decision.form.submit")}
            </Button>
            {replaces ? (
              <Button
                variant="secondary"
                onClick={() => {
                  form.setResult(null);
                  inline.hide();
                }}
              >
                {t("common.cancel")}
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <div>
          <Button
            ref={inline.trigger}
            variant="secondary"
            icon={<RefreshCcw size={16} strokeWidth={1.5} />}
            onClick={() => {
              form.setResult(null);
              inline.show();
              requestAnimationFrame(() => document.getElementById(ids.correctionReason)?.focus());
            }}
          >
            {t("people.decision.form.replace")}
          </Button>
        </div>
      )}
      <FormFeedback result={form.result} success={t("people.decision.form.saved")} fieldIds={ids} />
    </div>
  );
}
