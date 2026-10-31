"use client";

import type { TaskItem } from "@harbour/contracts";
import { Button, Sheet, SheetClose, TextArea } from "@harbour/ui";
import { Ban, CircleCheck, CircleMinus, Play, UserCheck, UserMinus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState, useTransition } from "react";
import { assignTask, transitionTask } from "@/app/actions/tasks";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { readTaskReason, TASK_REASON_MAX } from "@/lib/tasks";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

export type TaskDone = "started" | "done" | "skipped" | "cancelled" | "assigned" | "unassigned";

/** Opens the list again saying what was done (`at` makes each change a new arrival). */
function arrivalHref(returnTo: string, done: TaskDone): string {
  const url = new URL(returnTo, "http://harbour.invalid");
  url.searchParams.set("done", done);
  url.searchParams.set("at", String(Date.now()));
  return `${url.pathname}${url.search}`;
}

function useTaskSend(returnTo: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (done: TaskDone, call: () => Promise<ActionResult<unknown>>, after?: () => void) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        after?.();
        router.replace(arrivalHref(returnTo, done), { scroll: false });
        router.refresh();
      } else if (outcome.code === "version_conflict") {
        // Someone else changed the task: show it as it is now, with the words saying so.
        router.refresh();
      }
    });
  return { result, pending, send, setResult };
}

/** "Not done" or "Cancel task": a reason of 3 to 500 characters, in a dialog. */
function ReasonSheet({
  task,
  to,
  returnTo,
}: {
  readonly task: Pick<TaskItem, "id" | "version" | "title">;
  readonly to: "skipped" | "cancelled";
  readonly returnTo: string;
}) {
  const purpose = to === "skipped" ? "skip" : "cancel";
  const [open, setOpen] = useState(false);
  const { result, pending, send, setResult } = useTaskSend(returnTo);
  const reasonId = useId();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readTaskReason(new FormData(event.currentTarget), t, purpose);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      to,
      () => transitionTask({ id: task.id, to, version: task.version, reason: read.reason }),
      () => setOpen(false),
    );
  };
  const error = errorFor(result, "reason");
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          variant="secondary"
          icon={to === "skipped" ? <CircleMinus {...icon} /> : <Ban {...icon} />}
        >
          {t("tasks.action.open", { purpose })}
        </Button>
      }
      title={t("tasks.reason.title", { purpose, task: task.title })}
      closeLabel={t("common.close")}
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextArea
          id={reasonId}
          name="reason"
          label={t("tasks.reason.label", { purpose })}
          hint={t("tasks.reason.hint")}
          rows={3}
          required
          maxLength={TASK_REASON_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          {...(error ? { error } : {})}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("tasks.reason.keep")}</Button>
          </SheetClose>
          <Button
            type="submit"
            variant={to === "cancelled" ? "destructive" : "primary"}
            disabled={pending}
          >
            {pending ? t("common.saving") : t("tasks.reason.submit", { purpose })}
          </Button>
        </div>
        <ManageFeedback result={result} path={returnTo} fieldIds={{ reason: reasonId }} />
      </form>
    </Sheet>
  );
}

/**
 * What can be done with an open task, as the API allows: start it, mark it as done (a task that
 * needs evidence is completed by recording it on the person's record), say it was not done or
 * cancel it with a reason; a manager also takes it or unassigns it. Each change carries the
 * version shown, so a task someone else changed is refused and shown again.
 */
export function TaskActions({
  task,
  returnTo,
  selfId,
  mayManage,
}: {
  readonly task: Pick<
    TaskItem,
    "id" | "version" | "title" | "status" | "evidenceRequired" | "assigneeTenantUserId"
  >;
  readonly returnTo: string;
  readonly selfId: string;
  readonly mayManage: boolean;
}) {
  const { result, pending, send } = useTaskSend(returnTo);
  const move = (to: "in_progress" | "done", done: TaskDone) =>
    send(done, () => transitionTask({ id: task.id, to, version: task.version }));
  const assign = (assignee: string | null, done: TaskDone) =>
    send(done, () =>
      assignTask({ id: task.id, assigneeTenantUserId: assignee, version: task.version }),
    );
  return (
    <div className="flex flex-col gap-3">
      {task.evidenceRequired ? (
        <p className="m-0 text-body-dense">{t("tasks.evidenceRequired")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {task.status === "open" ? (
          <Button
            variant="secondary"
            icon={<Play {...icon} />}
            disabled={pending}
            onClick={() => move("in_progress", "started")}
          >
            {t("tasks.action.start")}
          </Button>
        ) : null}
        {task.evidenceRequired ? null : (
          <Button
            icon={<CircleCheck {...icon} />}
            disabled={pending}
            onClick={() => move("done", "done")}
          >
            {t("tasks.action.done")}
          </Button>
        )}
        <ReasonSheet task={task} to="skipped" returnTo={returnTo} />
        {mayManage ? <ReasonSheet task={task} to="cancelled" returnTo={returnTo} /> : null}
        {mayManage && task.assigneeTenantUserId !== selfId ? (
          <Button
            variant="secondary"
            icon={<UserCheck {...icon} />}
            disabled={pending}
            onClick={() => assign(selfId, "assigned")}
          >
            {t("tasks.action.take")}
          </Button>
        ) : null}
        {mayManage && task.assigneeTenantUserId ? (
          <Button
            variant="secondary"
            icon={<UserMinus {...icon} />}
            disabled={pending}
            onClick={() => assign(null, "unassigned")}
          >
            {t("tasks.action.unassign")}
          </Button>
        ) : null}
      </div>
      <ManageFeedback result={result} path={returnTo} />
    </div>
  );
}
