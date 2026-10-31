"use client";

import { Button, TextArea } from "@harbour/ui";
import { Archive, CircleCheck, FilePlus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { approveVersion, endVersion, startDraft } from "@/app/actions/letters";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { REASON_MAX, REASON_MIN } from "@/lib/letters";
import type { ActionResult } from "@/lib/outcome";

/**
 * Approving, retiring and discarding a template version, and starting a new draft (comms.md rules
 * 22 and 23). Each sends the version the page showed, so a version changed meanwhile is refused,
 * and on success the page opens again saying what was done (a new `at` each time, so the same
 * words are said again). A refusal is said in words, with the step-up notice where one is needed.
 */

export interface VersionRef {
  readonly templateId: string;
  readonly versionId: string;
  readonly version: number;
}

type Done = "approved" | "retired" | "discarded" | "started";

function useSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (done: Done, call: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) router.replace(`${path}?done=${done}&at=${Date.now()}`, { scroll: false });
    });
  return { result, setResult, pending, run };
}

/** Approve the draft: offered only to an approver who neither wrote nor edited it. */
export function ApproveVersion({
  target,
  path,
}: {
  readonly target: VersionRef;
  readonly path: string;
}) {
  const { result, pending, run } = useSend(path);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          icon={<CircleCheck size={20} strokeWidth={1.5} aria-hidden="true" />}
          disabled={pending}
          onClick={() => run("approved", () => approveVersion(target))}
        >
          {t("comms.templates.approve")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} />
    </div>
  );
}

/** A new draft from the version in use, which stays in use until the draft is approved. */
export function StartDraft({
  templateId,
  path,
}: {
  readonly templateId: string;
  readonly path: string;
}) {
  const { result, pending, run } = useSend(path);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          icon={<FilePlus size={20} strokeWidth={1.5} aria-hidden="true" />}
          disabled={pending}
          onClick={() => run("started", () => startDraft(templateId))}
        >
          {t("comms.templates.startDraft")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} />
    </div>
  );
}

/** Retire the version in use, or discard the draft: opens in place, with a reason. */
export function EndVersion({
  how,
  target,
  path,
}: {
  readonly how: "retire" | "discard";
  readonly target: VersionRef;
  readonly path: string;
}) {
  const inline = useInlineForm<HTMLTextAreaElement>();
  const ids = useFieldIds(["reason"]);
  const { result, setResult, pending, run } = useSend(path);
  const Icon = how === "retire" ? Archive : Trash2;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    run(how === "retire" ? "retired" : "discarded", () => endVersion(how, target, reason));
  };
  if (!inline.open) {
    return (
      <div>
        <Button
          ref={inline.trigger}
          variant="secondary"
          icon={<Icon size={20} strokeWidth={1.5} aria-hidden="true" />}
          onClick={() => {
            setResult(null);
            inline.show();
          }}
        >
          {t("comms.templates.end.open", { how })}
        </Button>
      </div>
    );
  }
  const error = result && !result.ok ? result.fields?.reason : undefined;
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <TextArea
        ref={inline.firstField}
        id={ids.reason}
        name="reason"
        label={t("comms.templates.end.reason", { how })}
        hint={t("comms.templates.end.hint", { how, min: REASON_MIN })}
        rows={3}
        required
        maxLength={REASON_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        {...(error ? { error } : {})}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="destructive" disabled={pending}>
          {t("comms.templates.end.submit", { how })}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setResult(null);
            inline.hide();
          }}
        >
          {t("common.cancel")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}
