"use client";

import {
  Button,
  ButtonLink,
  DateInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
  VisuallyHidden,
} from "@harbour/ui";
import {
  Calculator,
  CalendarPlus,
  Check,
  Coffee,
  Lock,
  LogIn,
  LogOut,
  Play,
  RotateCcw,
  Send,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import {
  approveEntry,
  approveRuleSet,
  calculatePayRun,
  clockEvent,
  correctPayRun,
  createPayRun,
  createRuleSet,
  decideAbsence,
  lockPayRun,
  overrideException,
  requestLeave,
} from "@/app/actions/pay-time";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { StepUpNotice } from "@/components/safety/ManageForms";
import { useSubmit } from "@/components/safety-silos/use-submit";
import { isUuid } from "@/lib/context-cookies";
import { uuidv7 } from "@/lib/entry-id";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor } from "@/lib/outcome";
import {
  ABSENCE_REQUEST_KINDS,
  PAY_FREQUENCIES,
  readDecision,
  readLeaveRequest,
  readOverride,
  readPayRun,
  readRuleSet,
} from "@/lib/pay-time";
import { dateBoxesOf, dateTimeLabels } from "@/lib/uk-time";

/**
 * The forms of the time, absence and pay screens (Phase 2 slice 60). Each is read and checked in
 * the browser first, then sent to its server action; the API checks every rule again. A refusal
 * that needs a second factor (pay needs MFA) offers it, keeping the page to come back to.
 */

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

function Feedback({
  result,
  success,
  fieldIds,
  path,
}: {
  readonly result: ActionResult<unknown> | null;
  readonly success: string;
  readonly fieldIds?: Readonly<Record<string, string>>;
  readonly path: string;
}) {
  if (
    result &&
    !result.ok &&
    (result.code === "step_up_required" || result.code === "mfa_verification_required")
  ) {
    return <StepUpNotice next={path} refusal={result} body={t("payTime.stepUp")} />;
  }
  if (result && !result.ok && result.code === "mfa_enrolment_required") {
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p className="m-0">{t("payTime.mfaEnrol")}</p>
        <div>
          <ButtonLink href="/settings/security?reason=mfa" variant="primary">
            {t("payTime.mfaEnrolLink")}
          </ButtonLink>
        </div>
      </div>
    );
  }
  return <FormFeedback result={result} success={success} {...(fieldIds ? { fieldIds } : {})} />;
}

/**
 * One button that sends one thing (no fields to check). `context` names what it acts on for a
 * screen reader ("Approve timesheet entry, Cat Carer, ..."), where the same button repeats down
 * the page. `replaced` marks a button the refresh takes away: success is then announced in the
 * page's status region and focus moves to the heading (WCAG 2.4.3, 4.1.3).
 */
function OneButton<R>({
  label,
  context,
  success,
  path,
  act,
  glyph,
  variant,
  replaced = false,
}: {
  readonly label: string;
  readonly context?: string;
  readonly success: string;
  readonly path: string;
  readonly act: () => Promise<ActionResult<R>>;
  readonly glyph: React.ReactNode;
  readonly variant?: "primary" | "secondary";
  readonly replaced?: boolean;
}) {
  const { submit, result, pending } = useSubmit(
    () => ({ ok: true, body: null }),
    act,
    undefined,
    replaced ? success : undefined,
  );
  return (
    <form method="post" onSubmit={submit} noValidate className="flex flex-col gap-2">
      <Feedback result={result} success={success} path={path} />
      <div>
        <Button type="submit" disabled={pending} variant={variant ?? "primary"} icon={glyph}>
          {pending ? t("common.saving") : label}
          {context && !pending ? <VisuallyHidden>{`, ${context}`}</VisuallyHidden> : null}
        </Button>
      </div>
    </form>
  );
}

/**
 * A step that cannot be undone (locking a pay run, starting a correction): the first button
 * opens a confirmation that says what happens, with the step and a way out; focus moves to it.
 */
function ConfirmStep<R>({
  open,
  question,
  body,
  confirm,
  keep,
  success,
  path,
  act,
  glyph,
  replaced,
}: {
  readonly open: string;
  readonly question: string;
  readonly body: string;
  readonly confirm: string;
  readonly keep: string;
  readonly success: string;
  readonly path: string;
  readonly act: () => Promise<ActionResult<R>>;
  readonly glyph: React.ReactNode;
  readonly replaced: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const questionId = useId();
  useEffect(() => {
    if (asking) panel.current?.focus();
  }, [asking]);
  if (!asking) {
    return (
      <div>
        <Button variant="secondary" icon={glyph} onClick={() => setAsking(true)}>
          {open}
        </Button>
      </div>
    );
  }
  return (
    <section
      ref={panel}
      aria-labelledby={questionId}
      tabIndex={-1}
      className="flex flex-col gap-3 rounded-input border-s-4 border-warning bg-bg-secondary p-4"
    >
      <p id={questionId} className="m-0 font-semibold">
        {question}
      </p>
      <p className="m-0">{body}</p>
      <div className="flex flex-wrap gap-3">
        <OneButton
          label={confirm}
          success={success}
          path={path}
          glyph={glyph}
          act={act}
          replaced={replaced}
        />
        <div>
          <Button variant="secondary" onClick={() => setAsking(false)}>
            {keep}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---- My clock -----------------------------------------------------------------------------

const CLOCK_GLYPHS = {
  in: <LogIn {...icon} />,
  break_start: <Coffee {...icon} />,
  break_end: <Play {...icon} />,
  out: <LogOut {...icon} />,
} as const;

/** Clocking in, out and for breaks on one of my shifts (scheduling.md section 16 rules 1 to 3). */
export function ClockButtons({
  shiftId,
  locationId,
}: {
  readonly shiftId: string;
  readonly locationId: string;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {(["in", "break_start", "break_end", "out"] as const).map((kind) => (
        <OneButton
          key={kind}
          label={t("payTime.clock.action", { kind })}
          success={t("payTime.clock.done", { kind })}
          path="/my-time"
          glyph={CLOCK_GLYPHS[kind]}
          variant={kind === "in" || kind === "out" ? "primary" : "secondary"}
          act={() =>
            clockEvent({
              id: uuidv7(),
              kind,
              locationId,
              shiftId,
              deviceTime: new Date().toISOString(),
            })
          }
        />
      ))}
    </div>
  );
}

// ---- Timesheet approval -------------------------------------------------------------------

export function ApproveEntryForm({
  id,
  version,
  context,
}: {
  readonly id: string;
  readonly version: number;
  readonly context: string;
}) {
  return (
    <OneButton
      label={t("payTime.entry.approve")}
      context={context}
      replaced
      success={t("payTime.entry.approvedDone")}
      path="/timesheets"
      glyph={<Check {...icon} />}
      act={() => approveEntry(id, version)}
    />
  );
}

// ---- Absence ------------------------------------------------------------------------------

export function LeaveRequestForm({ locationId }: { readonly locationId: string }) {
  const ids = useFieldIds(["kind", "startsOn", "endsOn"]);
  const { submit, result, pending } = useSubmit(
    (form) => readLeaveRequest(form, t, locationId),
    requestLeave,
    (_data, form) => form.reset(),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <Feedback
        result={result}
        success={t("payTime.absence.form.done")}
        fieldIds={ids}
        path="/absences"
      />
      <RadioGroup
        id={ids.kind}
        name="kind"
        legend={t("payTime.absence.form.kind")}
        options={ABSENCE_REQUEST_KINDS.map((value) => ({
          value,
          label: t("payTime.absence.kind", { kind: value }),
        }))}
        error={errorFor(result, "kind")}
      />
      <DateInput
        id={ids.startsOn}
        name="startsOn"
        legend={t("payTime.absence.form.start")}
        labels={dateTimeLabels(t)}
        hint={t("care.date.hint")}
        error={errorFor(result, "startsOn")}
        errorParts={dateBoxesOf(partsFor(result, "startsOn"))}
      />
      <DateInput
        id={ids.endsOn}
        name="endsOn"
        legend={t("payTime.absence.form.end")}
        labels={dateTimeLabels(t)}
        hint={t("care.date.hint")}
        error={errorFor(result, "endsOn")}
        errorParts={dateBoxesOf(partsFor(result, "endsOn"))}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Send {...icon} />}>
          {pending ? t("common.saving") : t("payTime.absence.form.submit")}
        </Button>
      </div>
    </form>
  );
}

export function DecisionForm({ id, version }: { readonly id: string; readonly version: number }) {
  const ids = useFieldIds(["decision", "reason"]);
  const { submit, result, pending } = useSubmit(
    (form) => readDecision(form, t, version),
    (body) => decideAbsence(id, body),
    undefined,
    t("payTime.absence.decide.done"),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <Feedback
        result={result}
        success={t("payTime.absence.decide.done")}
        fieldIds={ids}
        path="/absences"
      />
      <RadioGroup
        id={ids.decision}
        name="decision"
        legend={t("payTime.absence.decide.legend")}
        options={[
          { value: "approve", label: t("payTime.absence.decide.approve") },
          { value: "decline", label: t("payTime.absence.decide.decline") },
        ]}
        error={errorFor(result, "decision")}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("payTime.absence.decide.reason")}
        hint={t("payTime.absence.decide.reasonHint")}
        maxLength={500}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Send {...icon} />}>
          {pending ? t("common.saving") : t("payTime.absence.decide.submit")}
        </Button>
      </div>
    </form>
  );
}

// ---- Pay ----------------------------------------------------------------------------------

export function NewPayRunForm() {
  const router = useRouter();
  const ids = useFieldIds(["frequency", "periodStart", "periodEnd"]);
  const { submit, result, pending } = useSubmit(
    (form) => readPayRun(form, t),
    createPayRun,
    (data) => {
      if (isUuid(data?.id)) router.push(`/pay/${data.id}`);
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <Feedback result={result} success={t("payTime.run.form.done")} fieldIds={ids} path="/pay" />
      <SelectField
        id={ids.frequency}
        name="frequency"
        label={t("payTime.run.form.frequency")}
        options={PAY_FREQUENCIES.map((value) => ({
          value,
          label: t("payTime.frequency", { frequency: value }),
        }))}
        error={errorFor(result, "frequency")}
      />
      <DateInput
        id={ids.periodStart}
        name="periodStart"
        legend={t("payTime.run.form.start")}
        labels={dateTimeLabels(t)}
        hint={t("care.date.hint")}
        error={errorFor(result, "periodStart")}
        errorParts={dateBoxesOf(partsFor(result, "periodStart"))}
      />
      <DateInput
        id={ids.periodEnd}
        name="periodEnd"
        legend={t("payTime.run.form.end")}
        labels={dateTimeLabels(t)}
        hint={t("care.date.hint")}
        error={errorFor(result, "periodEnd")}
        errorParts={dateBoxesOf(partsFor(result, "periodEnd"))}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<CalendarPlus {...icon} />}>
          {pending ? t("common.saving") : t("payTime.run.form.submit")}
        </Button>
      </div>
    </form>
  );
}

export function RunActions({
  id,
  version,
  canCalculate,
  canLock,
  canCorrect,
  runName,
}: {
  readonly id: string;
  readonly version: number;
  readonly canCalculate: boolean;
  readonly canLock: boolean;
  readonly canCorrect: boolean;
  /** The run in words ("Weekly run, 05/10/2026 to 11/10/2026"), for the confirmation. */
  readonly runName: string;
}) {
  const router = useRouter();
  const path = `/pay/${id}`;
  return (
    <div className="flex flex-wrap gap-4">
      {canCalculate ? (
        <OneButton
          label={t("payTime.run.calculate")}
          success={t("payTime.run.calculated")}
          path={path}
          glyph={<Calculator {...icon} />}
          act={() => calculatePayRun(id, version)}
        />
      ) : null}
      {canLock ? (
        <ConfirmStep
          open={t("payTime.run.lock")}
          question={t("payTime.run.lockQuestion", { run: runName })}
          body={t("payTime.run.lockBody")}
          confirm={t("payTime.run.lock")}
          keep={t("payTime.run.keepDraft")}
          success={t("payTime.run.lockedDone")}
          path={path}
          glyph={<Lock {...icon} />}
          replaced
          act={() => lockPayRun(id, version)}
        />
      ) : null}
      {canCorrect ? (
        <ConfirmStep
          open={t("payTime.run.correct")}
          question={t("payTime.run.correctQuestion", { run: runName })}
          body={t("payTime.run.correctBody")}
          confirm={t("payTime.run.correct")}
          keep={t("payTime.run.keepAsIs")}
          success={t("payTime.run.corrected")}
          path={path}
          glyph={<RotateCcw {...icon} />}
          replaced={false}
          act={async () => {
            const out = await correctPayRun(id);
            if (out.ok && isUuid(out.data?.id)) router.push(`/pay/${out.data.id}`);
            return out;
          }}
        />
      ) : null}
    </div>
  );
}

export function OverrideForm({
  id,
  version,
  runId,
  context,
}: {
  readonly id: string;
  readonly version: number;
  readonly runId: string;
  readonly context: string;
}) {
  const ids = useFieldIds(["reason"]);
  const { submit, result, pending } = useSubmit(
    (form) => readOverride(form, t, version),
    (body) => overrideException(id, body),
    undefined,
    t("payTime.exception.overriddenDone"),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <Feedback
        result={result}
        success={t("payTime.exception.overriddenDone")}
        fieldIds={ids}
        path={`/pay/${runId}`}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("payTime.exception.reason")}
        hint={t("payTime.exception.reasonHint")}
        maxLength={500}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button type="submit" disabled={pending} variant="secondary" icon={<Check {...icon} />}>
          {pending ? t("common.saving") : t("payTime.exception.override")}
          {pending ? null : <VisuallyHidden>{`, ${context}`}</VisuallyHidden>}
        </Button>
      </div>
    </form>
  );
}

export function RuleSetForm() {
  const ids = useFieldIds(["name", "effectiveFrom", "roleRates", "sleepIn", "mileage"]);
  const { submit, result, pending } = useSubmit(
    (form) => readRuleSet(form, t),
    createRuleSet,
    (_data, form) => form.reset(),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <Feedback
        result={result}
        success={t("payTime.ruleSet.form.done")}
        fieldIds={ids}
        path="/pay/rule-sets"
      />
      <TextField
        id={ids.name}
        name="name"
        label={t("payTime.ruleSet.form.name")}
        autoComplete="off"
        maxLength={120}
        error={errorFor(result, "name")}
      />
      <DateInput
        id={ids.effectiveFrom}
        name="effectiveFrom"
        legend={t("payTime.ruleSet.form.from")}
        labels={dateTimeLabels(t)}
        hint={t("care.date.hint")}
        error={errorFor(result, "effectiveFrom")}
        errorParts={dateBoxesOf(partsFor(result, "effectiveFrom"))}
      />
      <TextArea
        id={ids.roleRates}
        name="roleRates"
        label={t("payTime.ruleSet.form.rates")}
        hint={t("payTime.ruleSet.form.ratesHint")}
        maxLength={4000}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "roleRates")}
      />
      <TextField
        id={ids.sleepIn}
        name="sleepIn"
        label={t("payTime.ruleSet.form.sleepIn")}
        hint={t("payTime.ruleSet.form.poundsHint")}
        inputMode="decimal"
        autoComplete="off"
        error={errorFor(result, "sleepIn")}
      />
      <TextField
        id={ids.mileage}
        name="mileage"
        label={t("payTime.ruleSet.form.mileage")}
        hint={t("payTime.ruleSet.form.poundsHint")}
        inputMode="decimal"
        autoComplete="off"
        error={errorFor(result, "mileage")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Send {...icon} />}>
          {pending ? t("common.saving") : t("payTime.ruleSet.form.submit")}
        </Button>
      </div>
    </form>
  );
}

export function ApproveRuleSetForm({
  id,
  version,
  context,
}: {
  readonly id: string;
  readonly version: number;
  readonly context: string;
}) {
  return (
    <OneButton
      label={t("payTime.ruleSet.approve")}
      context={context}
      replaced
      success={t("payTime.ruleSet.approvedDone")}
      path="/pay/rule-sets"
      glyph={<Check {...icon} />}
      act={() => approveRuleSet(id, version)}
    />
  );
}
