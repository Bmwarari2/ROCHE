"use client";

import { Button, DateTimeInput, TextArea } from "@harbour/ui";
import { CircleX, PencilLine, PlugZap } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState, useTransition } from "react";
import { cancelOutage, closeOutage, correctOutage } from "@/app/actions/downtime";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import { formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor, partsRefusal, refused } from "@/lib/outcome";
import { boxesOf, dateTimeLabels, readDateTimeField, ukRepeatedTime } from "@/lib/uk-time";

/**
 * Closing, cancelling and correcting an outage (operations.md section 13, part 3c). Each opens in
 * place from its button, sends the outage's version, and on success goes back to the outage's
 * page, which says what changed and takes focus there. No time is filled in for the person.
 */

interface OutageRef {
  readonly locationId: string;
  readonly outageId: string;
  readonly version: number;
}

type Done = "closed" | "cancelled" | "corrected";

function useOutageForm(ref: OutageRef, done: Done) {
  const router = useRouter();
  const inline = useInlineForm<HTMLElement>();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (send: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = await send();
      setResult(outcome);
      if (outcome.ok) {
        router.push(`/downtime/${ref.locationId}/outages/${ref.outageId}?done=${done}`, {
          scroll: false,
        });
      }
    });
  return { inline, result, setResult, pending, run };
}

function InlineAction({
  form,
  open,
  icon,
  destructive = false,
  children,
  success,
  fieldIds,
  firstFieldId,
}: {
  readonly form: ReturnType<typeof useOutageForm>;
  readonly open: string;
  readonly icon: ReactNode;
  readonly destructive?: boolean;
  readonly children: ReactNode;
  readonly success: string;
  readonly fieldIds: Readonly<Record<string, string>>;
  /** The field that takes focus when the form opens (a date's day box, or the reason). */
  readonly firstFieldId: string;
}) {
  const { inline } = form;
  useEffect(() => {
    if (inline.open) document.getElementById(firstFieldId)?.focus();
  }, [inline.open, firstFieldId]);
  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        children
      ) : (
        <div>
          <Button
            ref={inline.trigger}
            variant={destructive ? "secondary" : "primary"}
            icon={icon}
            onClick={() => {
              form.setResult(null);
              inline.show();
            }}
          >
            {open}
          </Button>
        </div>
      )}
      <FormFeedback result={form.result} success={success} fieldIds={fieldIds} />
    </div>
  );
}

function Actions({
  form,
  submit,
  destructive = false,
}: {
  readonly form: ReturnType<typeof useOutageForm>;
  readonly submit: string;
  readonly destructive?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="submit"
        variant={destructive ? "destructive" : "primary"}
        disabled={form.pending}
      >
        {submit}
      </Button>
      <Button
        variant="secondary"
        onClick={() => {
          form.setResult(null);
          form.inline.hide();
        }}
      >
        {t("common.cancel")}
      </Button>
    </div>
  );
}

const CLOSE_FIELDS = ["endedAt"] as const;

/** Systems are back: the true end, after which paper records are entered (rule 10). */
export function CloseOutageForm(props: OutageRef) {
  const form = useOutageForm(props, "closed");
  const ids = useFieldIds(CLOSE_FIELDS);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ended = readDateTimeField(new FormData(event.currentTarget), "endedAt", {
      subject: t("operations.outage.endSubject"),
      t,
    });
    if (!ended.ok) {
      form.setResult(partsRefusal("endedAt", ended));
      return;
    }
    form.run(() =>
      closeOutage(props.locationId, props.outageId, {
        endedAt: ended.instant ?? "",
        version: props.version,
      }),
    );
  };
  return (
    <InlineAction
      form={form}
      open={t("operations.outage.close.open")}
      icon={<PlugZap size={16} strokeWidth={1.5} />}
      success={t("operations.outage.arrived", { done: "closed" })}
      fieldIds={ids}
      firstFieldId={ids.endedAt}
    >
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <DateTimeInput
          id={ids.endedAt}
          legend={t("operations.outage.close.ended")}
          hint={t("operations.outage.close.hint")}
          name="endedAt"
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          error={errorFor(form.result, "endedAt")}
          errorParts={boxesOf(partsFor(form.result, "endedAt"))}
        />
        <Actions form={form} submit={t("operations.outage.close.submit")} />
      </form>
    </InlineAction>
  );
}

const REASON_FIELDS = ["reason"] as const;

/** Declared in error, and no paper record cites it yet (rule 15). */
export function CancelOutageForm(props: OutageRef) {
  const form = useOutageForm(props, "cancelled");
  const ids = useFieldIds(REASON_FIELDS);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    if (!reason.trim()) {
      form.setResult(refused(t("operations.outage.cancel.reasonRequired"), "invalid", ["reason"]));
      return;
    }
    form.run(() =>
      cancelOutage(props.locationId, props.outageId, { reason, version: props.version }),
    );
  };
  return (
    <InlineAction
      form={form}
      open={t("operations.outage.cancel.open")}
      icon={<CircleX size={16} strokeWidth={1.5} />}
      destructive
      success={t("operations.outage.arrived", { done: "cancelled" })}
      fieldIds={ids}
      firstFieldId={ids.reason}
    >
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <p className="m-0 font-semibold">{t("operations.outage.cancel.consequence")}</p>
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("operations.outage.cancel.reason")}
          hint={t("operations.outage.noNamesHint")}
          rows={3}
          required
          maxLength={1000}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(form.result, "reason")}
        />
        <Actions form={form} submit={t("operations.outage.cancel.submit")} destructive />
      </form>
    </InlineAction>
  );
}

const CORRECT_FIELDS = ["startedAt", "endedAt", "reason"] as const;

/**
 * The start or end was wrong (before reconciliation). An open outage stays open, so its end is
 * not asked for; the current times are shown beside the boxes, which start empty.
 */
export function CorrectOutageForm(
  props: OutageRef & { readonly startedAt: string; readonly endedAt: string | null },
) {
  const form = useOutageForm(props, "corrected");
  const ids = useFieldIds(CORRECT_FIELDS);
  const open = props.endedAt === null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const started = readDateTimeField(data, "startedAt", {
      subject: t("operations.outage.startSubject"),
      t,
    });
    if (!started.ok) {
      form.setResult(partsRefusal("startedAt", started));
      return;
    }
    let endedAt: string | null = null;
    if (!open) {
      const ended = readDateTimeField(data, "endedAt", {
        subject: t("operations.outage.endSubject"),
        t,
      });
      if (!ended.ok) {
        form.setResult(partsRefusal("endedAt", ended));
        return;
      }
      endedAt = ended.instant;
    }
    const reason = String(data.get("reason") ?? "");
    if (!reason.trim()) {
      form.setResult(refused(t("operations.outage.correct.reasonRequired"), "invalid", ["reason"]));
      return;
    }
    form.run(() =>
      correctOutage(props.locationId, props.outageId, {
        startedAt: started.instant ?? "",
        endedAt,
        reason,
        version: props.version,
      }),
    );
  };
  const now = (iso: string | null) => formatDateTime(iso) ?? t("common.notRecorded");
  return (
    <InlineAction
      form={form}
      open={t("operations.outage.correct.open")}
      icon={<PencilLine size={16} strokeWidth={1.5} />}
      destructive
      success={t("operations.outage.arrived", { done: "corrected" })}
      fieldIds={ids}
      firstFieldId={ids.startedAt}
    >
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <DateTimeInput
          id={ids.startedAt}
          legend={t("operations.outage.correct.started")}
          hint={t("operations.outage.correct.current", { dateTime: now(props.startedAt) })}
          name="startedAt"
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          error={errorFor(form.result, "startedAt")}
          errorParts={boxesOf(partsFor(form.result, "startedAt"))}
        />
        {open ? (
          <p className="m-0 text-body-dense text-text-secondary">
            {t("operations.outage.correct.staysOpen")}
          </p>
        ) : (
          <DateTimeInput
            id={ids.endedAt}
            legend={t("operations.outage.correct.ended")}
            hint={t("operations.outage.correct.current", { dateTime: now(props.endedAt) })}
            name="endedAt"
            labels={dateTimeLabels(t)}
            repeated={ukRepeatedTime}
            error={errorFor(form.result, "endedAt")}
            errorParts={boxesOf(partsFor(form.result, "endedAt"))}
          />
        )}
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("operations.outage.correct.reason")}
          hint={t("operations.outage.noNamesHint")}
          rows={2}
          required
          maxLength={500}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(form.result, "reason")}
        />
        <Actions form={form} submit={t("operations.outage.correct.submit")} />
      </form>
    </InlineAction>
  );
}
