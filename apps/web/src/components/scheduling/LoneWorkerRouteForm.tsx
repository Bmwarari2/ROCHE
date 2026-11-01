"use client";

import type { LoneWorkerRouteStep } from "@harbour/contracts";
import { Button, Checkbox, SelectField, TextField } from "@harbour/ui";
import { CircleAlert, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { setLoneWorkerRoute } from "@/app/actions/lone-worker";
import { FormFeedback } from "@/components/care/FormFeedback";
import { t } from "@/lib/i18n";
import { MAX_ROUTE_STEPS, ROUTE_CHANNELS, readRoute, targetValue } from "@/lib/lone-worker";
import { type ActionResult, collectedRefusal, errorFor } from "@/lib/outcome";

/**
 * Naming the on-call route (H-539; scheduling.md section 14.3 rules 1 and 4). Step 1 is the
 * on-call person or role, told the moment an alarm is raised; a later step is the Registered
 * Manager; every step reaches people away from the app. The API checks every role and person
 * again and refuses in words. Saving a valid route switches lone-worker check-ins on.
 */

interface Option {
  readonly value: string;
  readonly label: string;
}

interface Row {
  /** A key for React only, so removing a step never moves another step's answers. */
  readonly key: number;
  readonly step: LoneWorkerRouteStep;
}

let nextKey = 0;
const row = (step: LoneWorkerRouteStep): Row => {
  nextKey += 1;
  return { key: nextKey, step };
};
const blankStep = (afterMinutes: number): Row => row({ afterMinutes, channels: ["push", "email"] });

export function LoneWorkerRouteForm({
  steps: saved,
  version,
  roles,
  people,
}: {
  readonly steps: readonly LoneWorkerRouteStep[];
  readonly version: number | null;
  readonly roles: readonly Option[];
  /** Members who may be named, when the viewer may list the team; otherwise roles only. */
  readonly people: readonly Option[];
}) {
  const router = useRouter();
  const [steps, setSteps] = useState<readonly Row[]>(() =>
    saved.length > 0 ? saved.map(row) : [blankStep(1), blankStep(15)],
  );
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  // Where focus goes after a step is added (its minutes) or removed (the add button).
  const focusNext = useRef<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each change to the steps, once the new step is on the page.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === "add") addButton.current?.focus();
    else document.getElementById(target)?.focus();
  }, [steps]);
  const fieldIds = useMemo(() => {
    const ids: Record<string, string> = {};
    steps.forEach((_, index) => {
      const n = index + 1;
      ids[`step-${n}-minutes`] = n === 1 ? `route-step-1-target` : `route-step-${n}-minutes`;
      ids[`step-${n}-target`] = `route-step-${n}-target`;
      ids[`step-${n}-channel`] = `route-step-${n}-channel-push`;
    });
    return ids;
  }, [steps]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readRoute(new FormData(event.currentTarget), steps.length, t);
    if (!read.ok) {
      setResult(collectedRefusal(read.problems));
      return;
    }
    startTransition(async () => {
      const outcome = await setLoneWorkerRoute({ steps: read.steps, version });
      setResult(outcome);
      if (outcome.ok) router.refresh();
    });
  };

  const groups = [
    { label: t("scheduling.loneWorker.route.rolesGroup"), options: roles },
    ...(people.length > 0
      ? [{ label: t("scheduling.loneWorker.route.peopleGroup"), options: people }]
      : []),
  ];

  return (
    <form method="post" className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <ol className="m-0 flex list-none flex-col gap-6 p-0">
        {steps.map(({ key, step }, index) => {
          const n = index + 1;
          const channelError = errorFor(result, `step-${n}-channel`);
          return (
            <li key={key}>
              <fieldset className="m-0 flex flex-col gap-3 rounded-md border border-border-subtle p-4">
                <legend className="px-1 font-semibold">
                  {t("scheduling.loneWorker.route.step", { step: n })}
                </legend>
                <p className="m-0 text-body-dense text-text-secondary">
                  {n === 1
                    ? t("scheduling.loneWorker.route.firstHint")
                    : t("scheduling.loneWorker.route.laterHint")}
                </p>
                {n === 1 ? (
                  // Step 1 is told the moment the alarm is raised: no minutes to choose.
                  <input type="hidden" name="step-1-minutes" value="1" />
                ) : (
                  <TextField
                    id={`route-step-${n}-minutes`}
                    name={`step-${n}-minutes`}
                    inputMode="numeric"
                    className="w-32"
                    label={t("scheduling.loneWorker.route.minutes")}
                    hint={t("scheduling.loneWorker.route.minutesHint")}
                    defaultValue={String(step.afterMinutes)}
                    error={errorFor(result, `step-${n}-minutes`)}
                  />
                )}
                <SelectField
                  id={`route-step-${n}-target`}
                  name={`step-${n}-target`}
                  label={t("scheduling.loneWorker.route.target")}
                  emptyOption={t("scheduling.loneWorker.route.chooseTarget")}
                  defaultValue={targetValue(step)}
                  groups={groups}
                  error={errorFor(result, `step-${n}-target`)}
                />
                <fieldset
                  className="m-0 flex flex-col gap-2 border-0 p-0"
                  aria-describedby={channelError ? `route-step-${n}-channel-error` : undefined}
                >
                  <legend className="mb-1">{t("scheduling.loneWorker.route.channels")}</legend>
                  {channelError ? (
                    <p
                      id={`route-step-${n}-channel-error`}
                      className="hb-field__error m-0 flex items-center gap-2"
                    >
                      <CircleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                      {channelError}
                    </p>
                  ) : null}
                  {ROUTE_CHANNELS.map((channel) => (
                    <Checkbox
                      key={channel}
                      id={`route-step-${n}-channel-${channel}`}
                      name={`step-${n}-channel`}
                      value={channel}
                      defaultChecked={step.channels.includes(channel)}
                      aria-invalid={channelError ? true : undefined}
                      label={t("scheduling.loneWorker.channel", { channel })}
                    />
                  ))}
                </fieldset>
                {steps.length > 2 ? (
                  <div>
                    <Button
                      variant="secondary"
                      icon={<Trash2 size={16} strokeWidth={1.5} />}
                      onClick={() => {
                        // Errors are numbered by step, so they go with the old numbering.
                        setResult(null);
                        focusNext.current = "add";
                        setSteps((current) => current.filter((_, i) => i !== index));
                      }}
                    >
                      {t("scheduling.loneWorker.route.removeStep", { step: n })}
                    </Button>
                  </div>
                ) : null}
              </fieldset>
            </li>
          );
        })}
      </ol>
      {steps.length < MAX_ROUTE_STEPS ? (
        <div>
          <Button
            ref={addButton}
            variant="secondary"
            icon={<Plus size={16} strokeWidth={1.5} />}
            onClick={() => {
              setResult(null);
              focusNext.current = `route-step-${steps.length + 1}-minutes`;
              setSteps((current) => [
                ...current,
                blankStep((current.at(-1)?.step.afterMinutes ?? 0) + 15),
              ]);
            }}
          >
            {t("scheduling.loneWorker.route.addStep")}
          </Button>
        </div>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          {t("scheduling.loneWorker.route.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("scheduling.loneWorker.route.done")}
        fieldIds={fieldIds}
      />
    </form>
  );
}
