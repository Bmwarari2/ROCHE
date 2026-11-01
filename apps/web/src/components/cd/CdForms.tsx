"use client";

import { Button, DateTimeInput, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { BookOpen, ClipboardCheck, PenLine, Save, Signature } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import {
  openCdPage,
  recordCdEntry,
  recordStockCheck,
  signAsWitness,
} from "@/app/actions/controlled-drugs";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import {
  cdPageHref,
  RECORDED_MOVEMENTS,
  type Read,
  readCdEntry,
  readCorrection,
  readStockCheck,
  readWitness,
  type WaitingAssertion,
  WITNESSED,
} from "@/lib/controlled-drugs";
import { formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import { dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";

/**
 * The controlled drugs register forms (MEDS-005; medicines.md section 15 rules 3 to 6). Each is
 * read here first; the API runs every register rule, checks the step-up, the witness and the
 * balance, and answers in its own words. After a save the page reloads at an address that says what
 * was done, so it is announced and focus is not lost. A step-up refusal sends the person to confirm
 * it is them and back to the same page.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const count = (remaining: number) => characterCount(remaining);

function useCdSubmit<T, R>(
  path: string,
  read: (form: FormData) => Read<T>,
  act: (body: T) => Promise<ActionResult<R>>,
  /** The address parameters saying what was done; null when `arrival` moved elsewhere itself. */
  arrival: (data: R) => Record<string, string> | null,
) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = read(new FormData(event.currentTarget));
    if (!parsed.ok) return setResult(fieldErrors(parsed.errors));
    startTransition(async () => {
      const outcome = await act(parsed.body);
      setResult(outcome);
      if (outcome.ok) {
        const done = arrival(outcome.data);
        if (done) {
          const params = new URLSearchParams({ ...done, at: String(Date.now()) });
          router.push(`${path}?${params.toString()}`);
        }
        router.refresh();
      }
    });
  };
  const feedback = (fieldIds?: Record<string, string>) => (
    <ManageFeedback
      result={result}
      path={path}
      stepUp={t("cd.stepUp")}
      {...(fieldIds ? { fieldIds } : {})}
    />
  );
  return { result, pending, submit, feedback };
}

/** Opens the register page for a medicine on the MAR (the API refuses one that is not a CD). */
export function OpenPageForm({
  personId,
  entries,
}: {
  readonly personId: string;
  readonly entries: readonly { readonly id: string; readonly label: string }[];
}) {
  const ids = useFieldIds(["entryId"]);
  const path = `/people/${personId}/controlled-drugs`;
  const router = useRouter();
  const { result, pending, submit, feedback } = useCdSubmit(
    path,
    (form) => {
      const entryId = String(form.get("entryId") ?? "");
      return entries.some((e) => e.id === entryId)
        ? { ok: true, body: entryId }
        : { ok: false, errors: { entryId: t("cd.open.entryError") } };
    },
    (entryId) => openCdPage(personId, entryId),
    (page) => {
      if (!page) return { done: "opened" };
      router.push(`${cdPageHref(personId, page.id)}?done=opened&at=${Date.now()}`);
      return null;
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.entryId}
        name="entryId"
        label={t("cd.open.entry")}
        hint={t("cd.open.entryHint")}
        defaultValue=""
        emptyOption={t("cd.form.choose")}
        options={entries.map((e) => ({ value: e.id, label: e.label }))}
        error={errorFor(result, "entryId")}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<BookOpen {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("cd.open.submit")}
        </Button>
      </div>
      {feedback(ids)}
    </form>
  );
}

/** The witness signs for what they saw, and whom they watched record it (ADR-0084 on the web). */
export function WitnessForm({
  personId,
  pageId,
  recorders,
  unit,
}: {
  readonly personId: string;
  readonly pageId: string;
  readonly recorders: readonly { readonly id: string; readonly name: string }[];
  readonly unit: string;
}) {
  const ids = useFieldIds(["movement", "quantity", "recorderId"]);
  const offered = new Set(recorders.map((r) => r.id));
  const { result, pending, submit, feedback } = useCdSubmit(
    cdPageHref(personId, pageId),
    (form) => readWitness(form, t, offered),
    (body) => signAsWitness(personId, pageId, body),
    (signed) => ({ done: "witnessed", until: signed?.expiresAt ?? "" }),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("cd.witness.intro")}</p>
      <SelectField
        id={ids.movement}
        name="movement"
        label={t("cd.witness.movement")}
        defaultValue=""
        emptyOption={t("cd.form.choose")}
        options={WITNESSED.map((m) => ({ value: m, label: t("cd.witnessed", { movement: m }) }))}
        error={errorFor(result, "movement")}
      />
      <TextField
        id={ids.quantity}
        name="quantity"
        label={t("cd.witness.quantity", { unit })}
        hint={t("cd.witness.quantityHint")}
        inputMode="decimal"
        autoComplete="off"
        error={errorFor(result, "quantity")}
      />
      <SelectField
        id={ids.recorderId}
        name="recorderId"
        label={t("cd.witness.recorder")}
        hint={t("cd.witness.recorderHint")}
        defaultValue=""
        emptyOption={t("cd.form.choose")}
        options={recorders.map((r) => ({ value: r.id, label: r.name }))}
        error={errorFor(result, "recorderId")}
      />
      <div>
        <Button type="submit" icon={<Signature {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("cd.witness.submit")}
        </Button>
      </div>
      {feedback(ids)}
    </form>
  );
}

/** The second signature: one of the witness signatures waiting for this recorder, or why none. */
function WitnessChoice({
  id,
  waiting,
  loneAllowed,
  unit,
  result,
  reasonId,
}: {
  readonly id: string | undefined;
  readonly waiting: readonly WaitingAssertion[];
  readonly loneAllowed: boolean;
  readonly unit: string;
  readonly result: ActionResult<unknown> | null;
  readonly reasonId: string | undefined;
}) {
  const [choice, setChoice] = useState("");
  const options = [
    ...waiting.map((a) => ({
      value: a.id,
      label: t("cd.form.signature", {
        witness: a.witnessName,
        movement: t("cd.witnessed", { movement: a.movement }),
        quantity: a.quantity,
        unit,
        until: formatDateTime(a.expiresAt) ?? "",
      }),
    })),
    ...(loneAllowed ? [{ value: "none", label: t("cd.form.noWitness") }] : []),
  ];
  return (
    <>
      {waiting.length === 0 ? (
        <p className="m-0" id={id}>
          {t("cd.form.noSignatures")}
        </p>
      ) : null}
      {options.length > 0 ? (
        <RadioGroup
          id={id}
          name="witness"
          legend={t("cd.form.witness")}
          hint={t("cd.form.witnessHint")}
          options={options}
          onValueChange={setChoice}
          error={errorFor(result, "witness")}
        />
      ) : null}
      {choice === "none" ? (
        <TextArea
          id={reasonId}
          name="noWitnessReason"
          label={t("cd.form.noWitnessReason")}
          hint={t("cd.form.noWitnessReasonHint")}
          rows={2}
          maxLength={2000}
          formatCount={count}
          error={errorFor(result, "noWitnessReason")}
        />
      ) : null}
    </>
  );
}

/** A receipt, a return to the pharmacy, a disposal or a destruction. */
export function EntryForm({
  personId,
  pageId,
  waiting,
  loneAllowed,
  unit,
}: {
  readonly personId: string;
  readonly pageId: string;
  readonly waiting: readonly WaitingAssertion[];
  readonly loneAllowed: boolean;
  readonly unit: string;
}) {
  const ids = useFieldIds([
    "movement",
    "quantity",
    "occurredAt",
    "counterparty",
    "reference",
    "witness",
    "noWitnessReason",
  ]);
  const { result, pending, submit, feedback } = useCdSubmit(
    cdPageHref(personId, pageId),
    (form) => readCdEntry(form, t, { waiting: new Set(waiting.map((a) => a.id)), loneAllowed }),
    (body) => recordCdEntry(personId, pageId, body),
    () => ({ done: "recorded" }),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.movement}
        name="movement"
        label={t("cd.form.movement")}
        defaultValue=""
        emptyOption={t("cd.form.choose")}
        options={RECORDED_MOVEMENTS.map((m) => ({
          value: m,
          label: t("cd.movement", { movement: m }),
        }))}
        error={errorFor(result, "movement")}
      />
      <TextField
        id={ids.quantity}
        name="quantity"
        label={t("cd.form.quantity", { unit })}
        inputMode="decimal"
        autoComplete="off"
        error={errorFor(result, "quantity")}
      />
      <DateTimeInput
        id={ids.occurredAt}
        name="occurredAt"
        legend={t("cd.form.occurredAt")}
        hint={t("cd.form.occurredHint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "occurredAt")}
      />
      <TextField
        id={ids.counterparty}
        name="counterparty"
        label={t("cd.form.counterparty")}
        hint={t("cd.form.counterpartyHint")}
        autoComplete="off"
        error={errorFor(result, "counterparty")}
      />
      <TextField
        id={ids.reference}
        name="reference"
        label={t("cd.form.reference")}
        hint={t("cd.form.referenceHint")}
        autoComplete="off"
        error={errorFor(result, "reference")}
      />
      <WitnessChoice
        id={ids.witness}
        waiting={waiting}
        loneAllowed={loneAllowed}
        unit={unit}
        result={result}
        reasonId={ids.noWitnessReason}
      />
      <div>
        <Button type="submit" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("cd.form.submit")}
        </Button>
      </div>
      {feedback(ids)}
    </form>
  );
}

/** A correction of one entry, never an edit: the quantity (a signed change) or a detail. */
export function CorrectionForm({
  personId,
  pageId,
  entries,
  waiting,
  loneAllowed,
  unit,
}: {
  readonly personId: string;
  readonly pageId: string;
  readonly entries: readonly { readonly id: string; readonly label: string }[];
  readonly waiting: readonly WaitingAssertion[];
  readonly loneAllowed: boolean;
  readonly unit: string;
}) {
  const ids = useFieldIds([
    "correctsId",
    "corrects",
    "quantity",
    "reason",
    "reference",
    "witness",
    "noWitnessReason",
  ]);
  const [what, setWhat] = useState("");
  const { result, pending, submit, feedback } = useCdSubmit(
    cdPageHref(personId, pageId),
    (form) =>
      readCorrection(form, t, {
        entries: new Set(entries.map((e) => e.id)),
        waiting: new Set(waiting.map((a) => a.id)),
        loneAllowed,
      }),
    (body) => recordCdEntry(personId, pageId, body),
    () => ({ done: "corrected" }),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("cd.correct.intro")}</p>
      <SelectField
        id={ids.correctsId}
        name="correctsId"
        label={t("cd.correct.entry")}
        defaultValue=""
        emptyOption={t("cd.form.choose")}
        options={entries.map((e) => ({ value: e.id, label: e.label }))}
        error={errorFor(result, "correctsId")}
      />
      <RadioGroup
        id={ids.corrects}
        name="corrects"
        legend={t("cd.correct.what")}
        options={["quantity", "detail"].map((w) => ({
          value: w,
          label: t("cd.correct.whatOption", { what: w }),
        }))}
        onValueChange={setWhat}
        error={errorFor(result, "corrects")}
      />
      {what === "quantity" ? (
        <TextField
          id={ids.quantity}
          name="quantity"
          label={t("cd.correct.quantity", { unit })}
          hint={t("cd.correct.quantityHint")}
          inputMode="decimal"
          autoComplete="off"
          error={errorFor(result, "quantity")}
        />
      ) : null}
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("cd.correct.reason")}
        hint={t("cd.correct.reasonHint")}
        rows={2}
        maxLength={2000}
        formatCount={count}
        error={errorFor(result, "reason")}
      />
      <WitnessChoice
        id={ids.witness}
        waiting={waiting}
        loneAllowed={loneAllowed}
        unit={unit}
        result={result}
        reasonId={ids.noWitnessReason}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<PenLine {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("cd.correct.submit")}
        </Button>
      </div>
      {feedback(ids)}
    </form>
  );
}

/** A count against the page, witnessed; one that does not balance needs a reason. */
export function StockCheckForm({
  personId,
  pageId,
  waiting,
  loneAllowed,
  unit,
}: {
  readonly personId: string;
  readonly pageId: string;
  readonly waiting: readonly WaitingAssertion[];
  readonly loneAllowed: boolean;
  readonly unit: string;
}) {
  const ids = useFieldIds(["counted", "reason", "witness", "noWitnessReason"]);
  const { result, pending, submit, feedback } = useCdSubmit(
    cdPageHref(personId, pageId),
    (form) => readStockCheck(form, t, { waiting: new Set(waiting.map((a) => a.id)), loneAllowed }),
    (body) => recordStockCheck(personId, pageId, body),
    (out) => ({ done: out?.incidentRaised ? "countedIncident" : "counted" }),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="m-0 max-w-prose">{t("cd.check.intro")}</p>
      <TextField
        id={ids.counted}
        name="counted"
        label={t("cd.check.counted", { unit })}
        hint={t("cd.check.countedHint")}
        inputMode="decimal"
        autoComplete="off"
        error={errorFor(result, "counted")}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("cd.check.reason")}
        hint={t("cd.check.reasonHint")}
        rows={2}
        maxLength={2000}
        formatCount={count}
        error={errorFor(result, "reason")}
      />
      <WitnessChoice
        id={ids.witness}
        waiting={waiting}
        loneAllowed={loneAllowed}
        unit={unit}
        result={result}
        reasonId={ids.noWitnessReason}
      />
      <div>
        <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("cd.check.submit")}
        </Button>
      </div>
      {feedback(ids)}
    </form>
  );
}
