"use client";

import type {
  EligibilityItem,
  ShiftItem,
  ShiftKind,
  ShiftPatternItem,
  ShiftTemplateItem,
} from "@harbour/contracts";
import {
  Button,
  Checkbox,
  DateInput,
  SelectField,
  Sheet,
  SheetClose,
  TextArea,
  TextField,
} from "@harbour/ui";
import {
  CalendarPlus,
  CircleAlert,
  Plus,
  ShieldAlert,
  UserCheck,
  UserMinus,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import {
  addShiftFromTemplate,
  applyPattern,
  archiveShiftPattern,
  archiveShiftTemplate,
  assignShift,
  cancelShift,
  createShiftPattern,
  createShiftTemplate,
  removeAssignment,
  shiftEligibility,
  startRota,
} from "@/app/actions/rota";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";
import {
  JUSTIFICATION_MAX,
  justificationProblem,
  overrideKeys,
  readClockTime,
  rotaPage,
} from "@/lib/rota";
import { readDateField } from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const SHIFT_KINDS: readonly ShiftKind[] = [
  "work",
  "sleep_in",
  "on_call_at_workplace",
  "on_call_away",
  "training",
];

/**
 * Sends a step and, once done, opens `path` again saying what was done (`done`, a new `at`), so
 * focus moves to the page heading and a status says it.
 */
function useRotaSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (
    done: string,
    call: () => Promise<ActionResult<unknown>>,
    after?: (data: unknown) => void,
    to?: (data: unknown) => string,
  ) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        after?.(outcome.data);
        router.replace(`${to ? to(outcome.data) : path}?done=${done}&at=${Date.now()}`, {
          scroll: false,
        });
        router.refresh();
      }
    });
  return { result, pending, send, setResult };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Starts a draft rota for a run of dates (at most six weeks; rotas never overlap). */
export function StartRotaForm({
  locationId,
  path,
}: {
  readonly locationId: string;
  readonly path: string;
}) {
  const ids = useFieldIds(["startsOn", "endsOn"]);
  const { result, pending, send, setResult } = useRotaSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const starts = readDateField(form, "startsOn", { subject: t("rota.start.from"), t });
    const ends = readDateField(form, "endsOn", { subject: t("rota.start.to"), t });
    const errors: Record<string, string> = {};
    if (!starts.ok) errors.startsOn = starts.message;
    if (!ends.ok) errors.endsOn = ends.message;
    if (starts.ok && ends.ok && starts.date && ends.date && ends.date < starts.date) {
      errors.endsOn = t("rota.start.endBeforeStart");
    }
    if (Object.keys(errors).length > 0 || !starts.ok || !ends.ok)
      return setResult(fieldErrors(errors));
    send(
      "started",
      () => startRota(locationId, starts.date ?? "", ends.date ?? ""),
      undefined,
      (data) => rotaPage((data as { id: string }).id),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateInput
        id={ids.startsOn}
        name="startsOn"
        legend={t("rota.start.from")}
        error={errorFor(result, "startsOn")}
      />
      <DateInput
        id={ids.endsOn}
        name="endsOn"
        legend={t("rota.start.to")}
        hint={t("rota.start.toHint")}
        error={errorFor(result, "endsOn")}
      />
      <div>
        <Button type="submit" icon={<CalendarPlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("rota.start.submit")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
    </form>
  );
}

/** Makes a shift template: a name, the kind, the UK times, the break and whether it counts as care. */
export function TemplateForm({
  locationId,
  path,
}: {
  readonly locationId: string;
  readonly path: string;
}) {
  const ids = useFieldIds(["name", "kind", "start", "end", "breakMinutes"]);
  const { result, pending, send, setResult } = useRotaSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = text(form, "name");
    const start = readClockTime(text(form, "start"));
    const end = readClockTime(text(form, "end"));
    const breakText = text(form, "breakMinutes") || "0";
    const breakMinutes = Number(breakText);
    const errors: Record<string, string> = {};
    if (!name) errors.name = t("rota.template.nameRequired");
    if (start === null) errors.start = t("rota.template.timeFormat", { which: "start" });
    if (end === null) errors.end = t("rota.template.timeFormat", { which: "end" });
    if (!/^\d{1,3}$/.test(breakText) || breakMinutes > 240) {
      errors.breakMinutes = t("rota.template.breakRange");
    }
    if (Object.keys(errors).length > 0 || start === null || end === null) {
      return setResult(fieldErrors(errors));
    }
    send(
      "templateMade",
      () =>
        createShiftTemplate(locationId, {
          name,
          kind: (text(form, "kind") || "work") as ShiftKind,
          startMinute: start,
          endMinute: end,
          breakMinutes,
          supervised: form.get("supervised") === "yes",
          countsAsCare: form.get("countsAsCare") === "yes",
        }),
      () => formElement.reset(),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.name}
        name="name"
        label={t("rota.template.name")}
        hint={t("rota.template.nameHint")}
        maxLength={80}
        autoComplete="off"
        required
        error={errorFor(result, "name")}
      />
      <SelectField
        id={ids.kind}
        name="kind"
        label={t("rota.template.kind")}
        options={SHIFT_KINDS.map((k) => ({ value: k, label: t("rota.kind", { kind: k }) }))}
        defaultValue="work"
      />
      <div className="flex flex-wrap gap-4">
        <TextField
          id={ids.start}
          name="start"
          label={t("rota.template.start")}
          hint={t("rota.template.timeHint")}
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          required
          error={errorFor(result, "start")}
        />
        <TextField
          id={ids.end}
          name="end"
          label={t("rota.template.end")}
          hint={t("rota.template.endHint")}
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          required
          error={errorFor(result, "end")}
        />
        <TextField
          id={ids.breakMinutes}
          name="breakMinutes"
          label={t("rota.template.break")}
          hint={t("rota.template.breakHint")}
          inputMode="numeric"
          autoComplete="off"
          maxLength={3}
          defaultValue="0"
          error={errorFor(result, "breakMinutes")}
        />
      </div>
      <Checkbox
        name="countsAsCare"
        value="yes"
        defaultChecked
        label={t("rota.template.countsAsCare")}
      />
      <Checkbox name="supervised" value="yes" label={t("rota.template.supervised")} />
      <div>
        <Button type="submit" icon={<Plus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("rota.template.submit")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
    </form>
  );
}

/** Makes a shift pattern: a cycle of days, each with templates and how many of each. */
export function PatternForm({
  locationId,
  path,
  templates,
}: {
  readonly locationId: string;
  readonly path: string;
  readonly templates: readonly ShiftTemplateItem[];
}) {
  const ids = useFieldIds(["name", "cycleDays", "entries"]);
  const { result, pending, send, setResult } = useRotaSend(path);
  const [cycle, setCycle] = useState(7);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = text(form, "name");
    const errors: Record<string, string> = {};
    if (!name) errors.name = t("rota.pattern.nameRequired");
    const entries: { day: number; templateId: string; count: number }[] = [];
    for (let day = 0; day < cycle; day += 1) {
      for (const template of templates) {
        const raw = text(form, `count-${day}-${template.id}`);
        if (!raw || raw === "0") continue;
        const count = Number(raw);
        if (!/^\d{1,2}$/.test(raw) || count > 20) errors.entries = t("rota.pattern.countRange");
        else entries.push({ day, templateId: template.id, count });
      }
    }
    if (entries.length === 0 && !errors.entries) errors.entries = t("rota.pattern.entriesRequired");
    if (Object.keys(errors).length > 0) return setResult(fieldErrors(errors));
    send(
      "patternMade",
      () => createShiftPattern(locationId, { name, cycleDays: cycle, entries }),
      () => formElement.reset(),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.name}
        name="name"
        label={t("rota.pattern.name")}
        maxLength={80}
        autoComplete="off"
        required
        error={errorFor(result, "name")}
      />
      <SelectField
        id={ids.cycleDays}
        name="cycleDays"
        label={t("rota.pattern.cycle")}
        hint={t("rota.pattern.cycleHint")}
        value={String(cycle)}
        onChange={(e) => setCycle(Number(e.currentTarget.value))}
        options={[7, 14, 21, 28].map((n) => ({
          value: String(n),
          label: t("rota.pattern.cycleDays", { days: n }),
        }))}
      />
      <fieldset id={ids.entries} tabIndex={-1} className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-body font-semibold">{t("rota.pattern.entries")}</legend>
        <p className="m-0 max-w-prose text-body-dense">{t("rota.pattern.entriesHint")}</p>
        {errorFor(result, "entries") ? (
          <p className="m-0 flex gap-2">
            <CircleAlert {...icon} className="mt-0.5 shrink-0" />
            {errorFor(result, "entries")}
          </p>
        ) : null}
        <ul className="hb-long-list m-0 flex list-none flex-col gap-3 p-0">
          {Array.from({ length: cycle }, (_, day) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the day of the cycle is the item's identity.
            <li key={day} className="flex flex-col gap-2 border-b border-border pb-3">
              <p className="m-0 font-semibold">{t("rota.pattern.day", { day: day + 1 })}</p>
              <div className="flex flex-wrap gap-4">
                {templates.map((template) => (
                  <TextField
                    key={template.id}
                    name={`count-${day}-${template.id}`}
                    label={t("rota.pattern.count", { day: day + 1, template: template.name })}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={2}
                    defaultValue="0"
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
      </fieldset>
      <div>
        <Button type="submit" icon={<Plus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("rota.pattern.submit")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
    </form>
  );
}

/** A sheet that confirms one action; the footer sends it. */
function Confirm({
  label,
  title,
  buttonIcon,
  children,
  action,
  variant = "secondary",
}: {
  readonly label: string;
  readonly title: string;
  readonly buttonIcon: ReactNode;
  readonly children: ReactNode;
  readonly action: (close: () => void) => ReactNode;
  readonly variant?: "secondary" | "tertiary";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant={variant} icon={buttonIcon}>
          {label}
        </Button>
      }
      title={title}
      closeLabel={t("common.close")}
    >
      <div className="flex flex-col gap-4">
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("common.cancel")}</Button>
          </SheetClose>
          {action(() => setOpen(false))}
        </div>
      </div>
    </Sheet>
  );
}

/** Archives a template or a pattern after confirming; shifts already made stay as they are. */
export function ArchiveButton({
  kind,
  id,
  version,
  name,
  path,
}: {
  readonly kind: "template" | "pattern";
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly path: string;
}) {
  const { result, pending, send } = useRotaSend(path);
  return (
    <div className="flex flex-col gap-2">
      <Confirm
        label={t("rota.archive.open", { kind, name })}
        title={t("rota.archive.title", { kind })}
        buttonIcon={<X {...icon} />}
        action={(close) => (
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              close();
              send("archived", () =>
                kind === "template"
                  ? archiveShiftTemplate(id, version)
                  : archiveShiftPattern(id, version),
              );
            }}
          >
            {t("rota.archive.confirm", { kind })}
          </Button>
        )}
      >
        <p className="m-0">{t("rota.archive.about", { kind, name })}</p>
      </Confirm>
      <FormFeedback result={result && !result.ok ? result : null} success="" />
    </div>
  );
}

/** Adds a shift from a template on one of the rota's dates. */
export function AddShiftForm({
  rotaId,
  dates,
  templates,
}: {
  readonly rotaId: string;
  readonly dates: readonly { readonly value: string; readonly label: string }[];
  readonly templates: readonly ShiftTemplateItem[];
}) {
  const ids = useFieldIds(["date", "templateId"]);
  const { result, pending, send, setResult } = useRotaSend(rotaPage(rotaId));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const date = text(form, "date");
    const templateId = text(form, "templateId");
    const errors: Record<string, string> = {};
    if (!date) errors.date = t("rota.addShift.chooseDate");
    if (!templateId) errors.templateId = t("rota.addShift.chooseTemplate");
    if (Object.keys(errors).length > 0) return setResult(fieldErrors(errors));
    send("shiftAdded", () => addShiftFromTemplate(rotaId, date, templateId));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <div className="flex flex-wrap gap-4">
        <SelectField
          id={ids.date}
          name="date"
          label={t("rota.addShift.date")}
          emptyOption={t("rota.addShift.chooseDate")}
          options={dates}
          required
          error={errorFor(result, "date")}
        />
        <SelectField
          id={ids.templateId}
          name="templateId"
          label={t("rota.addShift.template")}
          emptyOption={t("rota.addShift.chooseTemplate")}
          options={templates.map((tpl) => ({ value: tpl.id, label: tpl.name }))}
          required
          error={errorFor(result, "templateId")}
        />
      </div>
      <div>
        <Button type="submit" variant="secondary" icon={<Plus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("rota.addShift.submit")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
    </form>
  );
}

/** Adds a pattern's open shifts on every date of the rota. */
export function ApplyPatternForm({
  rotaId,
  version,
  patterns,
}: {
  readonly rotaId: string;
  readonly version: number;
  readonly patterns: readonly ShiftPatternItem[];
}) {
  const ids = useFieldIds(["patternId"]);
  const { result, pending, send, setResult } = useRotaSend(rotaPage(rotaId));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const patternId = text(new FormData(event.currentTarget), "patternId");
    if (!patternId) return setResult(fieldErrors({ patternId: t("rota.applyPattern.choose") }));
    send("patternApplied", () => applyPattern(rotaId, patternId, version));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.patternId}
        name="patternId"
        label={t("rota.applyPattern.pattern")}
        hint={t("rota.applyPattern.hint")}
        emptyOption={t("rota.applyPattern.choose")}
        options={patterns.map((p) => ({ value: p.id, label: p.name }))}
        required
        error={errorFor(result, "patternId")}
      />
      <div>
        <Button
          type="submit"
          variant="secondary"
          icon={<CalendarPlus {...icon} />}
          disabled={pending}
        >
          {pending ? t("common.saving") : t("rota.applyPattern.submit")}
        </Button>
      </div>
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
    </form>
  );
}

/** A reason, then the action: cancel a shift, or take someone off it. */
function ReasonSheet({
  label,
  title,
  about,
  submit,
  buttonIcon,
  onSend,
  path,
  done,
}: {
  readonly label: string;
  readonly title: string;
  readonly about: string;
  readonly submit: string;
  readonly buttonIcon: ReactNode;
  readonly onSend: (reason: string) => Promise<ActionResult<unknown>>;
  readonly path: string;
  readonly done: string;
}) {
  const ids = useFieldIds(["reason"]);
  const [open, setOpen] = useState(false);
  const { result, pending, send, setResult } = useRotaSend(path);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = text(new FormData(event.currentTarget), "reason");
    if (!reason) return setResult(fieldErrors({ reason: t("rota.reason.required") }));
    send(
      done,
      () => onSend(reason),
      () => setOpen(false),
    );
  };
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" icon={buttonIcon}>
          {label}
        </Button>
      }
      title={title}
      closeLabel={t("common.close")}
    >
      <form method="post" className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <p className="m-0">{about}</p>
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("rota.reason.label")}
          rows={3}
          maxLength={500}
          required
          error={errorFor(result, "reason")}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("common.cancel")}</Button>
          </SheetClose>
          <Button type="submit" variant="destructive" disabled={pending}>
            {pending ? t("common.saving") : submit}
          </Button>
        </div>
        <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
      </form>
    </Sheet>
  );
}

export function CancelShiftButton({ shift }: { readonly shift: ShiftItem }) {
  return (
    <ReasonSheet
      label={t("rota.cancel.open")}
      title={t("rota.cancel.title", { label: shift.label })}
      about={t("rota.cancel.about")}
      submit={t("rota.cancel.submit")}
      buttonIcon={<X {...icon} />}
      path={rotaPage(shift.rotaId)}
      done="shiftCancelled"
      onSend={(reason) => cancelShift(shift.id, shift.version, reason)}
    />
  );
}

export function RemoveAssignmentButton({ shift }: { readonly shift: ShiftItem }) {
  const assignment = shift.assignment;
  if (!assignment) return null;
  return (
    <ReasonSheet
      label={t("rota.remove.open")}
      title={t("rota.remove.title", { name: assignment.worker.displayName })}
      about={t("rota.remove.about")}
      submit={t("rota.remove.submit")}
      buttonIcon={<UserMinus {...icon} />}
      path={rotaPage(shift.rotaId)}
      done="removed"
      onSend={(reason) => removeAssignment(assignment.id, assignment.version, reason)}
    />
  );
}

/**
 * Puts a member on an open shift (HZ-124): choose who, see whether the rostering rule allows it
 * and, if not, its blockers in words. A blocked member goes on only with a manager's override
 * (scheduling.rota.approve) that names each blocker it covers and says why; a missing right to
 * work is never overridden, and the page says so.
 */
export function AssignShift({
  shift,
  workers,
  canOverride,
}: {
  readonly shift: ShiftItem;
  readonly workers: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly jobTitle: string | null;
  }[];
  readonly canOverride: boolean;
}) {
  const ids = useFieldIds(["workerId", "justification", "covers"]);
  const { result, pending, send, setResult } = useRotaSend(rotaPage(shift.rotaId));
  const [checking, startChecking] = useTransition();
  const [workerId, setWorkerId] = useState("");
  const [answer, setAnswer] = useState<EligibilityItem | null>(null);

  const check = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workerId) return setResult(fieldErrors({ workerId: t("rota.assign.chooseWorker") }));
    setResult(null);
    startChecking(async () => {
      const out = await shiftEligibility(shift.id, workerId);
      if (out.ok) setAnswer(out.data);
      else setResult(out);
    });
  };

  const assign = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!answer) return;
    if (answer.allowed) {
      send("assigned", () => assignShift(shift.id, answer.workerId, shift.version));
      return;
    }
    const form = new FormData(event.currentTarget);
    const justification = text(form, "justification");
    const errors: Record<string, string> = {};
    const problem = justificationProblem(justification, t);
    if (problem) errors.justification = problem;
    if (form.get("covers") !== "yes") errors.covers = t("rota.override.coversRequired");
    if (Object.keys(errors).length > 0) return setResult(fieldErrors(errors));
    send("overridden", () =>
      assignShift(shift.id, answer.workerId, shift.version, {
        justification,
        blockerKeys: overrideKeys(answer.blockers),
      }),
    );
  };

  const worker = workers.find((w) => w.id === answer?.workerId);
  return (
    <div className="flex flex-col gap-3">
      <form method="post" className="flex flex-col gap-3" onSubmit={check} noValidate>
        <SelectField
          id={ids.workerId}
          name="workerId"
          label={t("rota.assign.worker", { label: shift.label })}
          emptyOption={t("rota.assign.chooseWorker")}
          options={workers.map((w) => ({
            value: w.id,
            label: w.jobTitle
              ? t("rota.assign.workerWithTitle", { name: w.displayName, title: w.jobTitle })
              : w.displayName,
          }))}
          value={workerId}
          onChange={(e) => {
            setWorkerId(e.currentTarget.value);
            setAnswer(null);
          }}
          error={errorFor(result, "workerId")}
        />
        <div>
          <Button
            type="submit"
            variant="secondary"
            icon={<UserCheck {...icon} />}
            disabled={checking}
          >
            {checking ? t("rota.assign.checking") : t("rota.assign.check")}
          </Button>
        </div>
      </form>
      {answer ? (
        <form method="post" className="flex flex-col gap-3" onSubmit={assign} noValidate>
          {answer.allowed ? (
            <p className="m-0 flex items-center gap-2" role="status">
              <UserCheck {...icon} className="shrink-0" />
              {t("rota.assign.allowed", { name: worker?.displayName ?? "" })}
            </p>
          ) : (
            <div className="flex flex-col gap-2" role="status">
              <p className="m-0 flex items-center gap-2 font-semibold">
                <ShieldAlert {...icon} className="shrink-0" />
                {t("rota.assign.blocked", { name: worker?.displayName ?? "" })}
              </p>
              <ul className="m-0 flex flex-col gap-1 pl-5">
                {answer.blockers.map((b) => (
                  <li key={b.key}>{b.message}</li>
                ))}
              </ul>
            </div>
          )}
          {answer.allowed ? (
            <div>
              <Button type="submit" icon={<UserCheck {...icon} />} disabled={pending}>
                {pending ? t("common.saving") : t("rota.assign.submit")}
              </Button>
            </div>
          ) : !answer.overridable ? (
            <p className="m-0 flex gap-2">
              <CircleAlert {...icon} className="mt-0.5 shrink-0" />
              {t("rota.override.rightToWork")}
            </p>
          ) : !canOverride ? (
            <p className="m-0 flex gap-2">
              <CircleAlert {...icon} className="mt-0.5 shrink-0" />
              {t("rota.override.needsApprover")}
            </p>
          ) : (
            <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
              <legend className="mb-2 text-body font-semibold">{t("rota.override.title")}</legend>
              <p className="m-0 max-w-prose">{t("rota.override.about")}</p>
              <TextArea
                id={ids.justification}
                name="justification"
                label={t("rota.override.justification")}
                hint={t("rota.override.justificationHint", { min: 10 })}
                rows={4}
                maxLength={JUSTIFICATION_MAX}
                required
                error={errorFor(result, "justification")}
              />
              <Checkbox
                id={ids.covers}
                name="covers"
                value="yes"
                label={t("rota.override.covers", {
                  count: answer.blockers.length,
                  blockers: answer.blockers.map((b) => b.message).join("; "),
                })}
                error={errorFor(result, "covers")}
              />
              <div>
                <Button
                  type="submit"
                  variant="destructive"
                  icon={<ShieldAlert {...icon} />}
                  disabled={pending}
                >
                  {pending ? t("common.saving") : t("rota.override.submit")}
                </Button>
              </div>
            </fieldset>
          )}
        </form>
      ) : null}
      <FormFeedback result={result && !result.ok ? result : null} success="" fieldIds={ids} />
    </div>
  );
}
