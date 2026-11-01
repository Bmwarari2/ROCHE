"use client";

import { Button, Checkbox, SelectField, TextArea, TextField } from "@harbour/ui";
import { Ban, CircleSlash, ShieldX, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { approveShred, cancelShred, refuseShred, requestShred } from "@/app/actions/shred";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import {
  REFUSAL_REASON_MAX,
  readShredApproval,
  readShredRefusal,
  readShredRequest,
  SHRED_CONFIRM_WORD,
  SHRED_PAGE,
  SHRED_REASON_MAX,
  shredHref,
} from "@/lib/shred";

/**
 * The whole-organisation shred forms (PLAT-012 part 2; platform.md rules 7 to 10). Each is read
 * here first, so a mistake is said at its field; the API decides every rule again. A refusal for
 * want of a fresh step-up sends the person to confirm it is them and back to the same page.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

function useShredSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = <T,>(call: () => Promise<ActionResult<T>>, next: (data: T) => string) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        router.replace(next(outcome.data), { scroll: false });
        router.refresh();
      }
    });
  const feedback = (fieldIds?: Record<string, string>) => (
    <ManageFeedback
      result={result}
      path={path}
      stepUp={t("shred.stepUp")}
      {...(fieldIds ? { fieldIds } : {})}
    />
  );
  return { result, pending, send, setResult, feedback };
}

const arrived = (path: string, done: string, extra: Record<string, string> = {}) =>
  `${path}?${new URLSearchParams({ done, ...extra, at: String(Date.now()) }).toString()}`;

function Irreversible({ id, error }: { readonly id: string; readonly error: string | undefined }) {
  return (
    <Checkbox
      id={id}
      name="irreversible"
      value="yes"
      required
      label={t("shred.irreversible")}
      {...(error ? { error } : {})}
    />
  );
}

/** Asking for a shred: the export it follows, the reason and the acknowledgement. */
export function RequestShredForm({
  exports,
}: {
  readonly exports: readonly { readonly id: string; readonly downloadedAt: string }[];
}) {
  const ids = useFieldIds(["exportId", "reason", "irreversible"]);
  const offered = new Set(exports.map((e) => e.id));
  const { result, pending, send, setResult, feedback } = useShredSend(SHRED_PAGE);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readShredRequest(new FormData(event.currentTarget), t, offered);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => requestShred(read.body),
      (data) =>
        data?.id ? arrived(shredHref(data.id), "requested") : arrived(SHRED_PAGE, "requested"),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.exportId}
        name="exportId"
        label={t("shred.request.export")}
        hint={t("shred.request.exportHint")}
        defaultValue=""
        emptyOption={t("shred.request.exportChoose")}
        options={exports.map((e) => ({
          value: e.id,
          label: t("shred.request.exportOption", { when: formatDateTime(e.downloadedAt) ?? "" }),
        }))}
        error={errorFor(result, "exportId")}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("shred.request.reason")}
        hint={t("shred.request.reasonHint")}
        rows={3}
        required
        maxLength={SHRED_REASON_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <Irreversible id={ids.irreversible} error={errorFor(result, "irreversible")} />
      <div>
        <Button type="submit" variant="destructive" icon={<ShieldX {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("shred.request.submit")}
        </Button>
      </div>
      {feedback(ids)}
    </form>
  );
}

/** Approving another person's request: the consequences again, the typed word, the acknowledgement. */
export function ApproveShredForm({
  id,
  organisation,
}: {
  readonly id: string;
  readonly organisation: string;
}) {
  const ids = useFieldIds(["confirmWord", "irreversible"]);
  const path = shredHref(id);
  const { result, pending, send, setResult, feedback } = useShredSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readShredApproval(new FormData(event.currentTarget), t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => approveShred(id),
      (data) =>
        arrived(path, "approved", {
          state: data?.request.status === "approved" ? "approved" : "shredding",
        }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div role="note" className="flex gap-3">
        <TriangleAlert {...icon} className="mt-0.5 shrink-0" />
        <div className="flex flex-col gap-2">
          <p className="m-0 font-semibold">{t("shred.what.cannotUndo")}</p>
          <p className="m-0">{t("shred.approve.restate", { organisation })}</p>
          <p className="m-0">{t("shred.what.rows")}</p>
        </div>
      </div>
      <TextField
        id={ids.confirmWord}
        name="confirmWord"
        label={t("shred.approve.word", { word: SHRED_CONFIRM_WORD })}
        autoComplete="off"
        spellCheck={false}
        required
        error={errorFor(result, "confirmWord")}
      />
      <Irreversible id={ids.irreversible} error={errorFor(result, "irreversible")} />
      <div>
        <Button type="submit" variant="destructive" icon={<ShieldX {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("shred.approve.submit")}
        </Button>
      </div>
      {feedback(ids)}
    </form>
  );
}

/** Refusing another person's request, with a reason. */
export function RefuseShredForm({ id }: { readonly id: string }) {
  const ids = useFieldIds(["reason"]);
  const path = shredHref(id);
  const { result, pending, send, setResult, feedback } = useShredSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readShredRefusal(new FormData(event.currentTarget), t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => refuseShred(id, read.reason),
      () => arrived(path, "refused"),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("shred.refuse.reason")}
        hint={t("shred.refuse.reasonHint")}
        rows={3}
        required
        maxLength={REFUSAL_REASON_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<Ban {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("shred.refuse.submit")}
        </Button>
      </div>
      {feedback(ids)}
    </form>
  );
}

/** Cancelling one's own request, or withdrawing a lapsed one. */
export function CancelShredForm({
  id,
  kind,
}: {
  readonly id: string;
  readonly kind: "cancel" | "withdraw";
}) {
  const path = shredHref(id);
  const { pending, send, feedback } = useShredSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send(
      () => cancelShred(id),
      () => arrived(path, kind === "cancel" ? "cancelled" : "withdrawn"),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <div>
        <Button
          type="submit"
          variant="secondary"
          icon={<CircleSlash {...icon} />}
          disabled={pending}
        >
          {pending ? t("common.saving") : t("shred.cancel.submit", { kind })}
        </Button>
      </div>
      {feedback()}
    </form>
  );
}
