"use client";

import { BREACH_REASONING_MIN } from "@harbour/domain";
import {
  Button,
  Checkbox,
  DateInput,
  DateTimeInput,
  RadioGroup,
  TextArea,
  TextField,
} from "@harbour/ui";
import { CheckCheck, ClipboardCheck, FilePlus, Gavel, Lock, Mail, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import {
  acknowledgeNotice,
  assessBreach,
  closeBreach,
  decideBreach,
  recordBreach,
  reportBreach,
  tellIndividuals,
} from "@/app/actions/breaches";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import {
  againstSuggestion,
  type BreachFactors,
  type BreachSuggestion,
  breachPath,
  FACTOR_FLAGS,
  readPeopleAffected,
  reportIsLate,
} from "@/lib/breaches";
import { BREACHES_PAGE } from "@/lib/data-rights";
import { characterCount, t } from "@/lib/i18n";
import {
  type ActionResult,
  collectedRefusal,
  errorFor,
  type FieldProblem,
  partsFor,
} from "@/lib/outcome";
import {
  boxesOf,
  dateBoxesOf,
  dateTimeLabels,
  readDateField,
  readDateTimeField,
  ukRepeatedTime,
} from "@/lib/uk-time";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

const dateLabels = () => ({
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
});

/** Sends an action and, once done, opens the breach again saying what was done (a new `at`). */
function useBreachSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (done: string, call: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) router.replace(`${path}?done=${done}&at=${Date.now()}`, { scroll: false });
    });
  return { result, setResult, pending, send };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

const RECORD_FIELDS = ["summary", "awareAt", "occurredAt"] as const;

/**
 * Records a breach (rule 18): what happened, with no names, when the organisation became aware
 * (the ICO clock starts there) and, if known, when it happened. Once recorded, its page opens.
 */
export function RecordBreachForm() {
  const router = useRouter();
  const ids = useFieldIds(RECORD_FIELDS);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const summary = text(form, "summary");
    if (summary.length < 10 || summary.length > 4000) {
      problems.push({ field: "summary", message: t("dataRights.breach.record.summaryRequired") });
    }
    const aware = readDateTimeField(form, "awareAt", {
      subject: t("dataRights.breach.record.awareSubject"),
      t,
      futureToleranceMinutes: 0,
    });
    if (!aware.ok) problems.push({ field: "awareAt", message: aware.message, parts: aware.parts });
    const occurred = readDateTimeField(form, "occurredAt", {
      subject: t("dataRights.breach.record.occurredSubject"),
      optional: true,
      t,
      futureToleranceMinutes: 0,
    });
    if (!occurred.ok) {
      problems.push({ field: "occurredAt", message: occurred.message, parts: occurred.parts });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !aware.ok || !occurred.ok || !aware.instant) {
      setResult(refusal);
      return;
    }
    const input = { summary, awareAt: aware.instant, occurredAt: occurred.instant };
    startTransition(async () => {
      const outcome = await recordBreach(input);
      setResult(outcome);
      if (outcome.ok && outcome.data) {
        router.push(`${breachPath(outcome.data.id)}?done=recorded&at=${Date.now()}`);
      }
    });
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextArea
        id={ids.summary}
        name="summary"
        label={t("dataRights.breach.record.summary")}
        hint={t("dataRights.breach.record.summaryHint")}
        rows={4}
        maxLength={4000}
        required
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "summary")}
      />
      <DateTimeInput
        id={ids.awareAt}
        name="awareAt"
        legend={t("dataRights.breach.record.aware")}
        hint={t("dataRights.breach.record.awareHint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "awareAt")}
        errorParts={boxesOf(partsFor(result, "awareAt"))}
      />
      <DateTimeInput
        id={ids.occurredAt}
        name="occurredAt"
        legend={t("dataRights.breach.record.occurred")}
        hint={t("dataRights.breach.record.occurredHint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "occurredAt")}
        errorParts={boxesOf(partsFor(result, "occurredAt"))}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<FilePlus {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.breach.record.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={BREACHES_PAGE} fieldIds={ids} />
    </form>
  );
}

const FACTOR_FIELDS = ["peopleAffected", ...FACTOR_FLAGS] as const;

/** The assessment factors (breach-response.md section 4), offered until the decision is made. */
export function AssessBreachForm({
  id,
  version,
  factors,
}: {
  readonly id: string;
  readonly version: number;
  readonly factors: BreachFactors | null;
}) {
  const path = breachPath(id);
  const ids = useFieldIds(FACTOR_FIELDS);
  const { result, setResult, pending, send } = useBreachSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const people = readPeopleAffected(text(form, "peopleAffected"));
    if (people === null) {
      setResult(
        collectedRefusal([
          { field: "peopleAffected", message: t("dataRights.breach.assess.peopleRequired") },
        ]),
      );
      return;
    }
    const flags = Object.fromEntries(
      FACTOR_FLAGS.map((flag) => [flag, form.get(flag) === "on"]),
    ) as Record<(typeof FACTOR_FLAGS)[number], boolean>;
    send("assessed", () => assessBreach(id, version, { peopleAffected: people, ...flags }));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.peopleAffected}
        name="peopleAffected"
        inputMode="numeric"
        autoComplete="off"
        label={t("dataRights.breach.assess.people")}
        hint={t("dataRights.breach.assess.peopleHint")}
        defaultValue={factors ? String(factors.peopleAffected) : ""}
        maxLength={10}
        className="max-w-48"
        error={errorFor(result, "peopleAffected")}
      />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-body font-semibold">
          {t("dataRights.breach.assess.flags")}
        </legend>
        {FACTOR_FLAGS.map((flag) => (
          <Checkbox
            key={flag}
            id={ids[flag]}
            name={flag}
            label={t("dataRights.breach.factor", { factor: flag })}
            defaultChecked={factors?.[flag] ?? false}
          />
        ))}
      </fieldset>
      <div>
        <Button type="submit" disabled={pending} icon={<ClipboardCheck {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.breach.assess.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

const DECISION_FIELDS = [
  "reportToIco",
  "tellIndividuals",
  "reasoning",
  "acknowledgedSuggestion",
] as const;

type YesNo = "yes" | "no";
const yesNo = (value: boolean | undefined): YesNo | null =>
  value === undefined ? null : value ? "yes" : "no";

/**
 * The decision (rule 20): report to the ICO or not, tell the people affected or not, with the
 * reasoning, and an acknowledgement when going against Harbour's suggestion. The decision is the
 * person's: the suggestion only informs it.
 */
export function DecideBreachForm({
  id,
  version,
  suggestion,
  decision,
}: {
  readonly id: string;
  readonly version: number;
  readonly suggestion: BreachSuggestion;
  readonly decision: {
    readonly reportToIco: boolean;
    readonly tellIndividuals: boolean;
    readonly reasoning: string;
  } | null;
}) {
  const path = breachPath(id);
  const ids = useFieldIds(DECISION_FIELDS);
  const { result, setResult, pending, send } = useBreachSend(path);
  const [report, setReport] = useState<YesNo | null>(yesNo(decision?.reportToIco));
  const [tell, setTell] = useState<YesNo | null>(yesNo(decision?.tellIndividuals));
  const against =
    report !== null &&
    tell !== null &&
    againstSuggestion(suggestion, {
      reportToIco: report === "yes",
      tellIndividuals: tell === "yes",
    });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reasoning = text(form, "reasoning");
    const acknowledged = form.get("acknowledgedSuggestion") === "on";
    const problems: FieldProblem[] = [];
    if (report === null) {
      problems.push({
        field: "reportToIco",
        message: t("dataRights.breach.decide.reportRequired"),
      });
    }
    if (tell === null) {
      problems.push({
        field: "tellIndividuals",
        message: t("dataRights.breach.decide.tellRequired"),
      });
    }
    if (reasoning.length < BREACH_REASONING_MIN || reasoning.length > 4000) {
      problems.push({
        field: "reasoning",
        message: t("dataRights.breach.decide.reasoningRequired", { min: BREACH_REASONING_MIN }),
      });
    }
    if (against && !acknowledged) {
      problems.push({
        field: "acknowledgedSuggestion",
        message: t("dataRights.refusal", { code: "acknowledgement_required" }),
      });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || report === null || tell === null) {
      setResult(refusal);
      return;
    }
    send("decided", () =>
      decideBreach(id, {
        expectedVersion: version,
        reportToIco: report === "yes",
        tellIndividuals: tell === "yes",
        reasoning,
        acknowledgedSuggestion: against && acknowledged,
      }),
    );
  };
  const options = (question: "report" | "tell") =>
    (["yes", "no"] as const).map((value) => ({
      value,
      label: t("dataRights.breach.decide.option", { question, value }),
    }));
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup<YesNo>
        id={ids.reportToIco}
        name="reportToIco"
        legend={t("dataRights.breach.decide.report")}
        options={options("report")}
        value={report}
        onValueChange={setReport}
        required
        error={errorFor(result, "reportToIco")}
      />
      <RadioGroup<YesNo>
        id={ids.tellIndividuals}
        name="tellIndividuals"
        legend={t("dataRights.breach.decide.tell")}
        options={options("tell")}
        value={tell}
        onValueChange={setTell}
        required
        error={errorFor(result, "tellIndividuals")}
      />
      <TextArea
        id={ids.reasoning}
        name="reasoning"
        label={t("dataRights.breach.decide.reasoning")}
        hint={t("dataRights.breach.decide.reasoningHint", { min: BREACH_REASONING_MIN })}
        rows={4}
        maxLength={4000}
        required
        defaultValue={decision?.reasoning ?? ""}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reasoning")}
      />
      {against ? (
        <Checkbox
          id={ids.acknowledgedSuggestion}
          name="acknowledgedSuggestion"
          label={t("dataRights.breach.decide.acknowledge")}
          hint={t("dataRights.breach.decide.acknowledgeHint")}
          error={errorFor(result, "acknowledgedSuggestion")}
        />
      ) : null}
      <div>
        <Button type="submit" disabled={pending} icon={<Gavel {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.breach.decide.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

const REPORT_FIELDS = ["reportedAt", "icoReference", "delayReason"] as const;

/**
 * The report to the ICO (rule 21): when it was made and the ICO's reference, with the reasons for
 * the delay when it was made after the deadline the API gave (Art 33(1)).
 */
export function ReportBreachForm({
  id,
  version,
  deadline,
  deadlinePassed,
}: {
  readonly id: string;
  readonly version: number;
  readonly deadline: string;
  readonly deadlinePassed: boolean;
}) {
  const path = breachPath(id);
  const ids = useFieldIds(REPORT_FIELDS);
  const { result, setResult, pending, send } = useBreachSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const reported = readDateTimeField(form, "reportedAt", {
      subject: t("dataRights.breach.report.whenSubject"),
      t,
      futureToleranceMinutes: 0,
    });
    if (!reported.ok) {
      problems.push({ field: "reportedAt", message: reported.message, parts: reported.parts });
    }
    const icoReference = text(form, "icoReference");
    if (icoReference.length === 0 || icoReference.length > 100) {
      problems.push({
        field: "icoReference",
        message: t("dataRights.breach.report.referenceRequired"),
      });
    }
    const delayReason = text(form, "delayReason");
    const late = reported.ok && reported.instant ? reportIsLate(deadline, reported.instant) : false;
    if ((late && delayReason.length === 0) || delayReason.length > 4000) {
      problems.push({
        field: "delayReason",
        message: t("dataRights.refusal", { code: "delay_reason_required" }),
      });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !reported.ok || !reported.instant) {
      setResult(refusal);
      return;
    }
    const reportedAt = reported.instant;
    send("reported", () =>
      reportBreach(id, {
        expectedVersion: version,
        reportedAt,
        icoReference,
        delayReason: delayReason.length > 0 ? delayReason : null,
      }),
    );
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateTimeInput
        id={ids.reportedAt}
        name="reportedAt"
        legend={t("dataRights.breach.report.when")}
        hint={t("care.when.hint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "reportedAt")}
        errorParts={boxesOf(partsFor(result, "reportedAt"))}
      />
      <TextField
        id={ids.icoReference}
        name="icoReference"
        label={t("dataRights.breach.report.reference")}
        hint={t("dataRights.breach.report.referenceHint")}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
        error={errorFor(result, "icoReference")}
      />
      <TextArea
        id={ids.delayReason}
        name="delayReason"
        label={t("dataRights.breach.report.delay")}
        hint={t("dataRights.breach.report.delayHint", {
          passed: deadlinePassed ? "yes" : "no",
        })}
        rows={3}
        maxLength={4000}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "delayReason")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Send {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.breach.report.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

const TELL_FIELDS = ["notice", "toldOn"] as const;

/**
 * The notice to the people affected (rule 22), prefilled from Harbour's plain-English template:
 * the parts in square brackets are for the person to write before it is sent.
 */
export function TellIndividualsForm({
  id,
  version,
  draft,
}: {
  readonly id: string;
  readonly version: number;
  readonly draft: string;
}) {
  const path = breachPath(id);
  const ids = useFieldIds(TELL_FIELDS);
  const { result, setResult, pending, send } = useBreachSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const notice = text(form, "notice");
    if (notice.length < 20 || notice.length > 10_000) {
      problems.push({ field: "notice", message: t("dataRights.breach.tell.noticeRequired") });
    }
    const told = readDateField(form, "toldOn", {
      subject: t("dataRights.breach.tell.toldSubject"),
      t,
    });
    if (!told.ok) problems.push({ field: "toldOn", message: told.message, parts: told.parts });
    const refusal = collectedRefusal(problems);
    if (refusal || !told.ok || !told.date) {
      setResult(refusal);
      return;
    }
    const toldOn = told.date;
    send("told", () => tellIndividuals(id, { expectedVersion: version, notice, toldOn }));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextArea
        id={ids.notice}
        name="notice"
        label={t("dataRights.breach.tell.notice")}
        hint={t("dataRights.breach.tell.noticeHint")}
        rows={14}
        maxLength={10_000}
        defaultValue={draft}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "notice")}
      />
      <DateInput
        id={ids.toldOn}
        name="toldOn"
        legend={t("dataRights.breach.tell.toldOn")}
        hint={t("care.date.hint")}
        labels={dateLabels()}
        error={errorFor(result, "toldOn")}
        errorParts={dateBoxesOf(partsFor(result, "toldOn"))}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Mail {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.breach.tell.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

const CLOSE_FIELDS = ["lessons"] as const;

/** Closes the entry with its lessons (rule 23); once closed nothing changes. */
export function CloseBreachForm({
  id,
  version,
}: {
  readonly id: string;
  readonly version: number;
}) {
  const path = breachPath(id);
  const ids = useFieldIds(CLOSE_FIELDS);
  const { result, setResult, pending, send } = useBreachSend(path);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const lessons = text(new FormData(event.currentTarget), "lessons");
    if (lessons.length < 20 || lessons.length > 4000) {
      setResult(
        collectedRefusal([
          { field: "lessons", message: t("dataRights.breach.close.lessonsRequired") },
        ]),
      );
      return;
    }
    send("closed", () => closeBreach(id, { expectedVersion: version, lessons }));
  };
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextArea
        id={ids.lessons}
        name="lessons"
        label={t("dataRights.breach.close.lessons")}
        hint={t("dataRights.breach.close.lessonsHint")}
        rows={4}
        maxLength={4000}
        required
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "lessons")}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<Lock {...icon} />}>
          {pending ? t("common.saving") : t("dataRights.breach.close.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}

/** Acknowledges one of Thapsus's notices about this breach, in the signed-in person's name. */
export function AcknowledgeNotice({
  breachId,
  noticeId,
}: {
  readonly breachId: string;
  readonly noticeId: string;
}) {
  const { result, pending, send } = useBreachSend(breachPath(breachId));
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          variant="secondary"
          disabled={pending}
          icon={<CheckCheck {...icon} />}
          onClick={() => send("acknowledged", () => acknowledgeNotice(breachId, noticeId))}
        >
          {pending ? t("common.saving") : t("dataRights.breach.notice.acknowledge")}
        </Button>
      </div>
      <ManageFeedback result={result} path={breachPath(breachId)} />
    </div>
  );
}
