"use client";

import type { LegalHoldItem, RetentionCandidate } from "@harbour/contracts";
import {
  Button,
  Checkbox,
  RadioGroup,
  SelectField,
  Sheet,
  SheetClose,
  TextArea,
  TextField,
} from "@harbour/ui";
import { Lock, LockOpen, Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { destroyDocuments, placeHold, releaseHold } from "@/app/actions/retention";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import {
  destroyOutcome,
  RETENTION_PAGE,
  RETENTION_REASON_MAX,
  readDestroy,
  readPlaceHold,
  readRelease,
} from "@/lib/retention";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

function useRetentionSend() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = <T,>(
    call: () => Promise<ActionResult<T>>,
    arrival: (data: T) => Record<string, string>,
    after?: () => void,
  ) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        after?.();
        const params = new URLSearchParams({ ...arrival(outcome.data), at: String(Date.now()) });
        router.replace(`${RETENTION_PAGE}?${params.toString()}`, { scroll: false });
        router.refresh();
      }
    });
  return { result, pending, send, setResult };
}

const feedback = (result: ActionResult<unknown> | null, fieldIds?: Record<string, string>) => (
  <ManageFeedback
    result={result}
    path={RETENTION_PAGE}
    stepUp={t("retention.stepUp")}
    {...(fieldIds ? { fieldIds } : {})}
  />
);

function ReasonField({
  id,
  purpose,
  error,
}: {
  readonly id: string;
  readonly purpose: "place" | "release" | "destroy";
  readonly error: string | undefined;
}) {
  return (
    <TextArea
      id={id}
      name="reason"
      label={t("retention.reason.label", { purpose })}
      hint={t("retention.reason.hint", { purpose })}
      rows={3}
      required
      maxLength={RETENTION_REASON_MAX}
      formatCount={(remaining) => characterCount(remaining)}
      {...(error ? { error } : {})}
    />
  );
}

/** Places a legal hold on a person (every record about them) or on one record, with a reason. */
export function PlaceHoldForm({
  people,
}: {
  readonly people: readonly { readonly id: string; readonly label: string }[];
}) {
  const ids = useFieldIds(["target", "personId", "subjectType", "subjectId", "reason"]);
  const [target, setTarget] = useState<"person" | "record">("person");
  const { result, pending, send, setResult } = useRetentionSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const read = readPlaceHold(new FormData(formElement), t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => placeHold(read.body),
      () => ({ done: "placed" }),
      () => formElement.reset(),
    );
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup<"person" | "record">
        id={ids.target}
        name="target"
        legend={t("retention.hold.target")}
        value={target}
        onValueChange={setTarget}
        options={[
          { value: "person", label: t("retention.hold.targetPerson") },
          { value: "record", label: t("retention.hold.targetRecord") },
        ]}
      />
      {target === "person" ? (
        <SelectField
          id={ids.personId}
          name="personId"
          label={t("retention.hold.person")}
          hint={t("retention.hold.personHint")}
          emptyOption={t("retention.hold.choosePerson")}
          options={people.map((p) => ({ value: p.id, label: p.label }))}
          error={errorFor(result, "personId")}
        />
      ) : (
        <>
          <TextField
            id={ids.subjectType}
            name="subjectType"
            label={t("retention.hold.type")}
            hint={t("retention.hold.typeHint")}
            autoComplete="off"
            error={errorFor(result, "subjectType")}
          />
          <TextField
            id={ids.subjectId}
            name="subjectId"
            label={t("retention.hold.id")}
            hint={t("retention.hold.idHint")}
            autoComplete="off"
            error={errorFor(result, "subjectId")}
          />
        </>
      )}
      <ReasonField id={ids.reason} purpose="place" error={errorFor(result, "reason")} />
      <div>
        <Button type="submit" icon={<Lock {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("retention.hold.submit")}
        </Button>
      </div>
      {feedback(result, ids)}
    </form>
  );
}

/** Releases a hold, with a reason, in a dialog; records it holds become due again if past retention. */
export function ReleaseHoldForm({
  hold,
  about,
}: {
  readonly hold: Pick<LegalHoldItem, "id" | "version">;
  readonly about: string;
}) {
  const ids = useFieldIds(["reason"]);
  const [open, setOpen] = useState(false);
  const { result, pending, send, setResult } = useRetentionSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readRelease(new FormData(event.currentTarget), t);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    send(
      () => releaseHold({ id: hold.id, version: hold.version, reason: read.reason }),
      () => ({ done: "released" }),
      () => setOpen(false),
    );
  };
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" icon={<LockOpen {...icon} />}>
          {t("retention.release.open")}
        </Button>
      }
      title={t("retention.release.title")}
      description={about}
      closeLabel={t("common.close")}
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <p className="m-0">{t("retention.release.body")}</p>
        <ReasonField id={ids.reason} purpose="release" error={errorFor(result, "reason")} />
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("retention.release.keep")}</Button>
          </SheetClose>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("retention.release.submit")}
          </Button>
        </div>
        {feedback(result, ids)}
      </form>
    </Sheet>
  );
}

/**
 * Destroys documents past retention. Each is ticked; a reason and a box saying the files cannot
 * be recovered are required; then a dialog says again, in plain words, what will happen and asks
 * to confirm. Only what the API offered is listed, which never includes anything under a legal
 * hold; the API checks each again and skips any held or no longer due.
 */
export function DestroyForm({
  candidates,
}: {
  readonly candidates: readonly RetentionCandidate[];
}) {
  const ids = useFieldIds(["documentId", "reason", "irreversible"]);
  const offered = new Set(candidates.map((c) => c.documentId));
  const [ready, setReady] = useState<{ documentIds: string[]; reason: string } | null>(null);
  const { result, pending, send, setResult } = useRetentionSend();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readDestroy(new FormData(event.currentTarget), t, offered);
    if (!read.ok) return setResult(fieldErrors(read.errors));
    setResult(null);
    setReady({ documentIds: read.documentIds, reason: read.reason });
  };
  const confirm = () => {
    if (!ready) return;
    send(
      () => destroyDocuments(ready),
      (data) => {
        const outcome = data ? destroyOutcome(data) : { destroyed: 0, skipped: 0, certificates: 0 };
        return {
          done: "destroyed",
          destroyed: String(outcome.destroyed),
          skipped: String(outcome.skipped),
          certificates: String(outcome.certificates),
        };
      },
      () => setReady(null),
    );
  };
  const listError = errorFor(result, "documentId");
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <fieldset
        id={ids.documentId}
        className="m-0 flex flex-col gap-2 border-0 p-0"
        aria-describedby={listError ? `${ids.documentId}-error` : undefined}
      >
        <legend className="mb-2 font-semibold">{t("retention.destroy.legend")}</legend>
        {listError ? (
          <p id={`${ids.documentId}-error`} className="hb-field__error m-0">
            {listError}
          </p>
        ) : null}
        {candidates.map((c) => (
          <Checkbox
            key={c.documentId}
            name="documentId"
            value={c.documentId}
            label={t("retention.destroy.item", {
              title: c.title ?? t("retention.destroy.untitled"),
              category: c.category,
            })}
            hint={t("retention.destroy.itemHint", {
              recordClass: c.retentionClass,
              stored: formatDateTime(c.createdAt ?? null) ?? "-",
              since: formatDateTime(c.eligibleSince) ?? "",
            })}
          />
        ))}
      </fieldset>
      <ReasonField id={ids.reason} purpose="destroy" error={errorFor(result, "reason")} />
      <Checkbox
        id={ids.irreversible}
        name="irreversible"
        value="yes"
        label={t("retention.destroy.irreversible")}
        error={errorFor(result, "irreversible")}
      />
      <div>
        <Button type="submit" variant="destructive" icon={<Trash2 {...icon} />}>
          {t("retention.destroy.open")}
        </Button>
      </div>
      {ready === null ? feedback(result, ids) : null}
      <Sheet
        open={ready !== null}
        onOpenChange={(open) => {
          if (!open) setReady(null);
        }}
        title={t("retention.destroy.confirmTitle", { count: ready?.documentIds.length ?? 0 })}
        closeLabel={t("common.close")}
      >
        <div className="flex flex-col gap-4">
          <div role="note" className="flex gap-3">
            <TriangleAlert {...icon} className="mt-0.5 shrink-0" />
            <div className="flex flex-col gap-2">
              <p className="m-0 font-semibold">{t("retention.destroy.cannotUndo")}</p>
              <p className="m-0">{t("retention.destroy.whatHappens")}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <SheetClose asChild>
              <Button variant="secondary">{t("retention.destroy.keep")}</Button>
            </SheetClose>
            <Button variant="destructive" disabled={pending} onClick={confirm}>
              {pending
                ? t("common.saving")
                : t("retention.destroy.confirm", { count: ready?.documentIds.length ?? 0 })}
            </Button>
          </div>
          {feedback(result)}
        </div>
      </Sheet>
    </form>
  );
}
