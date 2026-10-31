"use client";

import { Button, Checkbox, DateTimeInput, RadioGroup, TextField } from "@harbour/ui";
import { ListPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { createTask, createTaskSeries } from "@/app/actions/tasks";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor } from "@/lib/outcome";
import { type Repeat, readNewTask, TASK_TITLE_MAX } from "@/lib/tasks";
import { boxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * A manager's new task (platform.task.manage): a title, when it is due (UK time, 24-hour), urgent
 * or routine, optionally their own, once or repeating every day or every week from that day.
 * Errors are said at each field and in a summary that takes focus.
 */
export function NewTaskForm({
  selfId,
  returnTo,
}: {
  readonly selfId: string;
  readonly returnTo: string;
}) {
  const router = useRouter();
  const ids = useFieldIds(["title", "dueAt", "repeat"]);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const read = readNewTask(new FormData(formElement), t, { selfId });
    if (!read.ok) {
      const [first] = Object.values(read.errors);
      setResult({
        ok: false,
        code: "invalid",
        message: first ?? "",
        fields: read.errors,
        ...(read.parts ? { parts: read.parts } : {}),
      });
      return;
    }
    startTransition(async () => {
      const outcome =
        read.kind === "once" ? await createTask(read.body) : await createTaskSeries(read.body);
      setResult(outcome);
      if (outcome.ok) {
        formElement.reset();
        const url = new URL(returnTo, "http://harbour.invalid");
        url.searchParams.set("done", read.kind === "once" ? "created" : "scheduled");
        url.searchParams.set("at", String(Date.now()));
        router.replace(`${url.pathname}${url.search}`, { scroll: false });
        router.refresh();
      }
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.title}
        name="title"
        label={t("tasks.new.title")}
        hint={t("tasks.new.titleHint")}
        maxLength={TASK_TITLE_MAX}
        required
        autoComplete="off"
        error={errorFor(result, "title")}
      />
      <DateTimeInput
        id={ids.dueAt}
        name="dueAt"
        legend={t("tasks.new.due")}
        hint={t("care.when.hint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "dueAt")}
        errorParts={boxesOf(partsFor(result, "dueAt"))}
      />
      <RadioGroup<Repeat>
        id={ids.repeat}
        name="repeat"
        legend={t("tasks.new.repeat")}
        defaultValue="none"
        options={(["none", "daily", "weekly"] as const).map((repeat) => ({
          value: repeat,
          label: t("tasks.new.repeatOption", { repeat }),
        }))}
      />
      <Checkbox name="urgent" value="yes" label={t("tasks.new.urgent")} />
      <Checkbox name="assignToMe" value="yes" label={t("tasks.new.assignToMe")} />
      <div>
        <Button type="submit" icon={<ListPlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("tasks.new.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success="" fieldIds={ids} />
    </form>
  );
}
