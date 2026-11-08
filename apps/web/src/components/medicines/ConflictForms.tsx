"use client";

import {
  Button,
  ButtonLink,
  Checkbox,
  DateTimeInput,
  dateTimePartsAt,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { ClipboardCheck, RefreshCw, Signature, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { correctAdministration, resolveConflict } from "@/app/actions/administration-corrections";
import { useFieldIds } from "@/components/care/form-state";
import { Notice } from "@/components/care/Notice";
import { CdRecordingBanner } from "@/components/cd/CdRecordingBanner";
import { ManageFeedback } from "@/components/safety/ManageForms";
import {
  type Administration,
  type Decision,
  type RegisterMove,
  readCorrection,
  readDecision,
  registerMove,
  typedCorrection,
} from "@/lib/administration-corrections";
import { doseWitnessHref, type WaitingAssertion } from "@/lib/controlled-drugs";
import { characterCount, t } from "@/lib/i18n";
import {
  OUTCOME_REASON_CODES,
  OUTCOMES,
  type Outcome,
  outcomeTakesAmount,
} from "@/lib/medicine-round";
import { type ActionResult, errorFor, fieldErrors, partsFor } from "@/lib/outcome";
import { boxesOf, dateTimeLabels, readDateTimeField, ukRepeatedTime } from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const count = (remaining: number) => characterCount(remaining);

/** After a save, reload `path` saying what was done, so it is announced and focus is not lost. */
function useArrive() {
  const router = useRouter();
  return (path: string, done: string) => {
    const join = path.includes("?") ? "&" : "?";
    router.push(`${path}${join}done=${done}&at=${Date.now()}`);
    router.refresh();
  };
}

/**
 * Deciding a dose recorded twice (HZ-004; medicines.md 15.4): what happened, with what was found
 * out. "Given twice" asks again before it raises a medication incident. A controlled drug needs a
 * fresh sign-in: a refusal for one says so and links to it, coming back here.
 */
export function ConflictDecisionForm({
  conflictId,
  offered,
  correctionId,
  path,
  done,
}: {
  readonly conflictId: string;
  readonly offered: readonly Decision[];
  readonly correctionId: string | null;
  /** This page, for the way back after a fresh sign-in. */
  readonly path: string;
  /** Where to go once decided. */
  readonly done: string;
}) {
  const ids = useFieldIds(["outcome", "note"]);
  const arrive = useArrive();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const confirmRef = useRef<HTMLDivElement>(null);
  // The question "given twice?" is announced and focused when it appears (A1).
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = readDecision(new FormData(event.currentTarget), t, offered, correctionId);
    if (!parsed.ok) return setResult(fieldErrors(parsed.errors));
    setResult(null);
    if (parsed.body.outcome === "both_given" && !confirming) return setConfirming(true);
    startTransition(async () => {
      const outcome = await resolveConflict(conflictId, parsed.body);
      setResult(outcome);
      setConfirming(false);
      if (outcome.ok) arrive(done, "resolved");
    });
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.outcome}
        name="outcome"
        legend={t("medicines.conflicts.form.outcome")}
        options={offered.map((o) => ({
          value: o,
          label: t("medicines.conflicts.decision", { outcome: o }),
          description: t("medicines.conflicts.decisionHint", { outcome: o }),
        }))}
        onValueChange={() => setConfirming(false)}
        error={errorFor(result, "outcome")}
      />
      <TextArea
        id={ids.note}
        name="note"
        label={t("medicines.conflicts.form.note")}
        hint={t("medicines.conflicts.form.noteHint")}
        rows={3}
        maxLength={2000}
        formatCount={count}
        error={errorFor(result, "note")}
      />
      <div ref={confirmRef} tabIndex={-1} aria-live="assertive" className="outline-offset-2">
        {confirming ? (
          <Notice
            tone="warning"
            icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
            title={t("medicines.conflicts.form.confirmBothGiven")}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
          {pending
            ? t("common.saving")
            : t(confirming ? "medicines.conflicts.form.raise" : "medicines.conflicts.form.submit")}
        </Button>
        {confirming ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setConfirming(false);
              // The button goes, so focus returns to the question it came from.
              document.getElementById(ids.outcome ?? "")?.focus();
            }}
          >
            {t("medicines.conflicts.form.keepReviewing")}
          </Button>
        ) : null}
      </div>
      <ManageFeedback
        result={result}
        path={path}
        stepUp={t("medicines.conflicts.stepUp")}
        fieldIds={ids}
      />
    </form>
  );
}

/** What the witness signs for, in words. */
function moveWords(move: RegisterMove, unit: string): string {
  return t("medicines.correct.witness.move", {
    movement: move.movement,
    quantity: String(move.quantity),
    unit,
  });
}

/**
 * Correcting an administration record (HZ-004; medicines.md 14.4): what happened, as corrected,
 * with why; the record corrected is kept and shown struck through. For a controlled drug whose
 * register this moves, the page says exactly what the witness signs for and gives the link they
 * open in their own session; their signature is then chosen here. The API decides again.
 */
export function AdministrationCorrectionForm({
  personId,
  original,
  recordId,
  unitCode,
  unitName,
  controlledDrug,
  recordingOn,
  cdPageId,
  recorderId,
  waiting,
  loneAllowed,
  path,
  done,
  person,
}: {
  readonly personId: string;
  readonly original: Administration;
  /** The correction's client id, fixed for the page so the witness signs for it. */
  readonly recordId: string;
  readonly unitCode: string | null;
  readonly unitName: string | null;
  readonly controlledDrug: boolean;
  /** Controlled drugs recording is turned on at the person's home (H-1517). */
  readonly recordingOn: boolean;
  /** The person's register page for the medicine, for the witness's link; null when none. */
  readonly cdPageId: string | null;
  /** The member signed in, whom the witness watches record the correction. */
  readonly recorderId: string;
  readonly waiting: readonly WaitingAssertion[];
  readonly loneAllowed: boolean;
  readonly path: string;
  readonly done: string;
  readonly person: ReactNode;
}) {
  const ids = useFieldIds([
    "outcome",
    "reasonCode",
    "reasonNote",
    "quantity",
    "givenAt",
    "correctionReason",
    "amountDifferenceReason",
    "timingReason",
    "intervalOverrideReason",
    "covert",
    "witness",
    "noWitnessReason",
  ]);
  const router = useRouter();
  const arrive = useArrive();
  const [outcome, setOutcome] = useState<string>(original.outcome);
  const [code, setCode] = useState<string>(original.reason?.code ?? "");
  const [move, setMove] = useState<RegisterMove | null>(null);
  const [witness, setWitness] = useState<string>("");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const [checking, startChecking] = useTransition();
  const [checked, setChecked] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  const turnedOff = result !== null && !result.ok && result.code === "cd_recording_not_enabled";
  // The banner takes focus when the register refuses, so the reason is read first (A5).
  useEffect(() => {
    if (turnedOff) bannerRef.current?.focus();
  }, [turnedOff]);
  const unit = unitName ?? unitCode ?? "";
  const witnessLink = cdPageId
    ? (m: RegisterMove) =>
        doseWitnessHref(personId, cdPageId, { administrationId: recordId, ...m, recorderId })
    : null;
  const codes = (OUTCOMES as readonly string[]).includes(outcome)
    ? OUTCOME_REASON_CODES[outcome as Outcome]
    : [];
  const signed = move
    ? waiting.filter(
        (w) =>
          w.administrationId === recordId &&
          w.movement === move.movement &&
          w.quantity === move.quantity,
      )
    : [];
  const recompute = (form: HTMLFormElement) => {
    if (!controlledDrug) return;
    const data = new FormData(form);
    const typed = typedCorrection(data);
    const when = readDateTimeField(data, "givenAt", { subject: "", t, futureToleranceMinutes: 0 });
    setMove(
      when.ok && when.instant ? registerMove(original, { ...typed, givenAt: when.instant }) : null,
    );
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = readCorrection(new FormData(event.currentTarget), t, {
      id: recordId,
      original,
      unitCode,
      controlledDrug,
      waiting: new Set(signed.map((s) => s.id)),
      loneAllowed,
    });
    if (!parsed.ok) return setResult(fieldErrors(parsed.errors));
    startTransition(async () => {
      const sent = await correctAdministration(personId, original.id, parsed.body);
      setResult(sent);
      if (sent.ok) arrive(done, "corrected");
    });
  };
  // Refused because the register is not turned on here: the paper register is the record, so the
  // form goes and the API's words stay (H-1517).
  if (turnedOff) {
    return (
      <div ref={bannerRef} tabIndex={-1} className="flex flex-col gap-3 outline-offset-2">
        <CdRecordingBanner on={false} />
        <ManageFeedback result={result} path={path} />
      </div>
    );
  }
  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={submit}
      onChange={(e) => recompute(e.currentTarget)}
      noValidate
    >
      {person}
      <RadioGroup
        id={ids.outcome}
        name="outcome"
        legend={t("medicines.correct.form.outcome")}
        defaultValue={original.outcome}
        options={OUTCOMES.map((o) => ({
          value: o,
          label: t("medicines.round.outcome", { outcome: o }),
        }))}
        onValueChange={(value) => {
          setOutcome(value);
          setCode("");
        }}
        error={errorFor(result, "outcome")}
      />
      {codes.length > 0 ? (
        <SelectField
          key={outcome}
          id={ids.reasonCode}
          name="reasonCode"
          label={t("medicines.round.form.reason")}
          value={code}
          emptyOption={t("medicines.form.choose")}
          options={codes.map((c) => ({
            value: c,
            label: t("medicines.round.reason", { code: c }),
          }))}
          onChange={(e) => setCode(e.target.value)}
          error={errorFor(result, "reasonCode")}
        />
      ) : null}
      {code === "other" ? (
        <TextArea
          id={ids.reasonNote}
          name="reasonNote"
          label={t("medicines.round.form.reasonNote")}
          rows={2}
          maxLength={2000}
          formatCount={count}
          error={errorFor(result, "reasonNote")}
        />
      ) : null}
      {outcomeTakesAmount(outcome) && unitCode ? (
        <>
          <TextField
            id={ids.quantity}
            name="quantity"
            label={t("medicines.round.form.quantity", { unit })}
            hint={t("medicines.round.form.quantityHint")}
            inputMode="decimal"
            defaultValue={original.amount ? String(original.amount.quantity) : ""}
            error={errorFor(result, "quantity")}
          />
          <TextArea
            id={ids.amountDifferenceReason}
            name="amountDifferenceReason"
            label={t("medicines.round.form.amountDifferenceReason")}
            hint={t("medicines.round.form.askedHint")}
            rows={2}
            maxLength={2000}
            formatCount={count}
            error={errorFor(result, "amountDifferenceReason")}
          />
        </>
      ) : null}
      {outcomeTakesAmount(outcome) && !unitCode ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("medicines.round.unitUnknown")}
        />
      ) : null}
      <DateTimeInput
        id={ids.givenAt}
        name="givenAt"
        legend={t("medicines.correct.form.givenAt")}
        hint={t("medicines.correct.form.givenAtHint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        defaultValue={dateTimePartsAt(Date.parse(original.givenAt))}
        error={errorFor(result, "givenAt")}
        errorParts={boxesOf(partsFor(result, "givenAt"))}
      />
      {outcome === "given" ? (
        <Checkbox
          id={ids.covert}
          name="covert"
          value="yes"
          defaultChecked={original.covert}
          label={t("medicines.round.form.covert")}
          hint={t("medicines.correct.form.covertHint")}
          error={errorFor(result, "covert")}
        />
      ) : null}
      <TextArea
        id={ids.timingReason}
        name="timingReason"
        label={t("medicines.round.form.timingReason")}
        hint={t("medicines.round.form.askedHint")}
        rows={2}
        maxLength={2000}
        formatCount={count}
        error={errorFor(result, "timingReason")}
      />
      <TextArea
        id={ids.intervalOverrideReason}
        name="intervalOverrideReason"
        label={t("medicines.round.form.intervalOverrideReason")}
        hint={t("medicines.round.form.askedHint")}
        rows={2}
        maxLength={2000}
        formatCount={count}
        error={errorFor(result, "intervalOverrideReason")}
      />
      <TextArea
        id={ids.correctionReason}
        name="correctionReason"
        label={t("medicines.correct.form.reason")}
        hint={t("medicines.correct.form.reasonHint")}
        rows={3}
        maxLength={2000}
        formatCount={count}
        error={errorFor(result, "correctionReason")}
      />
      {/* Always mounted, so what the witness signs for is announced as it changes (A6, A4). */}
      <p className="sr-only" aria-live="polite">
        {controlledDrug && move && recordingOn
          ? t("medicines.correct.witness.signsFor", { what: moveWords(move, unit) })
          : ""}
      </p>
      <p className="sr-only" aria-live="polite">
        {checked && !checking
          ? t(
              signed.length > 0
                ? "medicines.correct.witness.found"
                : "medicines.correct.witness.notYet",
            )
          : ""}
      </p>
      {controlledDrug && move && recordingOn ? (
        <fieldset className="flex flex-col gap-3 rounded-input border border-border p-3">
          <legend className="px-1 font-semibold">{t("medicines.correct.witness.title")}</legend>
          {/* Announced by the live region above; shown here only, so it is not read twice. */}
          <p className="m-0" aria-hidden="true">
            {t("medicines.correct.witness.signsFor", { what: moveWords(move, unit) })}
          </p>
          {witnessLink ? (
            <>
              <p className="m-0 max-w-prose">{t("medicines.correct.witness.linkIntro")}</p>
              {/* The address, for reading out to the witness; the link below is the same (A11). */}
              <p className="m-0 break-all font-mono text-body-dense" aria-hidden="true">
                {witnessLink(move)}
              </p>
              <div className="flex flex-wrap gap-3">
                <ButtonLink
                  href={witnessLink(move)}
                  variant="secondary"
                  icon={<Signature {...icon} />}
                >
                  {t("medicines.correct.witness.open")}
                </ButtonLink>
                <Button
                  type="button"
                  variant="secondary"
                  icon={<RefreshCw {...icon} />}
                  disabled={checking}
                  onClick={() => {
                    setChecked(true);
                    startChecking(() => router.refresh());
                  }}
                >
                  {checking
                    ? t("medicines.correct.witness.checking")
                    : t("medicines.correct.witness.check")}
                </Button>
              </div>
            </>
          ) : (
            <p className="m-0">{t("medicines.correct.witness.noPage")}</p>
          )}
          <SelectField
            id={ids.witness}
            name="witness"
            label={t("medicines.correct.witness.choose")}
            value={witness}
            emptyOption={t("medicines.form.choose")}
            options={[
              ...signed.map((s) => ({
                value: s.id,
                label: t("medicines.correct.witness.signature", { name: s.witnessName }),
              })),
              ...(loneAllowed ? [{ value: "none", label: t("cd.form.noWitness") }] : []),
            ]}
            onChange={(e) => setWitness(e.target.value)}
            error={errorFor(result, "witness")}
          />
          {witness === "none" ? (
            <TextArea
              id={ids.noWitnessReason}
              name="noWitnessReason"
              label={t("cd.form.noWitnessReason")}
              rows={2}
              maxLength={2000}
              formatCount={count}
              error={errorFor(result, "noWitnessReason")}
            />
          ) : null}
        </fieldset>
      ) : null}
      <div>
        <Button type="submit" icon={<ClipboardCheck {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("medicines.correct.form.submit")}
        </Button>
      </div>
      <ManageFeedback
        result={result}
        path={path}
        stepUp={t("medicines.conflicts.stepUp")}
        fieldIds={ids}
      />
    </form>
  );
}
