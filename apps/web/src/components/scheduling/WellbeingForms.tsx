"use client";

import type { SurveyQuestion } from "@harbour/contracts";
import {
  Button,
  Checkbox,
  DateInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { Plus, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  answerSurvey,
  createSurvey,
  moveSurvey,
  recordCheckIn,
  shareCheckIn,
  thankColleague,
} from "@/app/actions/wellbeing";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, collectedRefusal, errorFor, partsFor, refused } from "@/lib/outcome";
import { dateBoxesOf } from "@/lib/uk-time";
import { MAX_QUESTIONS, MOODS, readAnswers, readSurvey, SCALE_POINTS } from "@/lib/wellbeing";

/**
 * Staff wellbeing forms (scheduling.md section 16). Each checks what it can before sending and
 * shows the API's refusal in words. Nothing here scores or judges anyone.
 */

interface Option {
  readonly value: string;
  readonly label: string;
}

const dateLabels = () => ({
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
});

interface Row {
  readonly key: number;
  readonly kind: SurveyQuestion["kind"];
}
let nextKey = 0;
const newRow = (kind: SurveyQuestion["kind"] = "scale"): Row => {
  nextKey += 1;
  return { key: nextKey, kind };
};

/** Write a survey as a draft: where, the title, the dates and its questions. */
export function SurveyForm({ places }: { readonly places: readonly Option[] }) {
  const router = useRouter();
  const ids = useFieldIds(["locationId", "title", "opensOn", "closesOn"] as const);
  const [rows, setRows] = useState<readonly Row[]>(() => [newRow()]);
  const [said, setSaid] = useState("");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const focusNext = useRef<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each change to the questions, once the new one is on the page.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === "add") addButton.current?.focus();
    else document.getElementById(target)?.focus();
  }, [rows]);
  const fieldIds = useMemo(() => {
    const all: Record<string, string> = { ...ids };
    rows.forEach((_, index) => {
      const n = index + 1;
      all[`q-${n}-kind`] = `survey-q-${n}-kind`;
      all[`q-${n}-text`] = `survey-q-${n}-text`;
    });
    return all;
  }, [ids, rows]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readSurvey(new FormData(event.currentTarget), rows.length, t);
    if (!read.ok) {
      setResult(collectedRefusal(read.problems));
      return;
    }
    startTransition(async () => {
      const outcome = await createSurvey(read.draft);
      setResult(outcome);
      if (outcome.ok) {
        router.push(`/wellbeing/surveys/${outcome.data.id}?done=written`, { scroll: false });
      }
    });
  };

  return (
    <form method="post" className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <SelectField
        id={ids.locationId}
        name="locationId"
        label={t("scheduling.wellbeing.form.where")}
        hint={t("scheduling.wellbeing.form.whereHint")}
        emptyOption={t("scheduling.wellbeing.form.chooseWhere")}
        options={places}
        error={errorFor(result, "locationId")}
      />
      <TextField
        id={ids.title}
        name="title"
        label={t("scheduling.wellbeing.form.title")}
        error={errorFor(result, "title")}
      />
      <DateInput
        id={ids.opensOn}
        name="opensOn"
        legend={t("scheduling.wellbeing.form.opensOn")}
        hint={t("care.date.hint")}
        labels={dateLabels()}
        error={errorFor(result, "opensOn")}
        errorParts={dateBoxesOf(partsFor(result, "opensOn"))}
      />
      <DateInput
        id={ids.closesOn}
        name="closesOn"
        legend={t("scheduling.wellbeing.form.closesOn")}
        hint={t("scheduling.wellbeing.form.closesHint")}
        labels={dateLabels()}
        error={errorFor(result, "closesOn")}
        errorParts={dateBoxesOf(partsFor(result, "closesOn"))}
      />
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {rows.map((row, index) => {
          const n = index + 1;
          return (
            <li key={row.key}>
              <fieldset className="m-0 flex flex-col gap-3 rounded-md border border-border-subtle p-4">
                <legend className="px-1 font-semibold">
                  {t("scheduling.wellbeing.form.question", { n })}
                </legend>
                <TextField
                  id={`survey-q-${n}-text`}
                  name={`q-${n}-text`}
                  label={t("scheduling.wellbeing.form.questionText")}
                  hint={t("scheduling.wellbeing.form.questionHint")}
                  error={errorFor(result, `q-${n}-text`)}
                />
                <RadioGroup
                  id={`survey-q-${n}-kind`}
                  name={`q-${n}-kind`}
                  legend={t("scheduling.wellbeing.form.kind")}
                  defaultValue={row.kind}
                  layout="inline"
                  options={[
                    { value: "scale", label: t("scheduling.wellbeing.form.kindScale") },
                    { value: "free_text", label: t("scheduling.wellbeing.form.kindText") },
                  ]}
                  error={errorFor(result, `q-${n}-kind`)}
                />
                {rows.length > 1 ? (
                  <div>
                    <Button
                      variant="secondary"
                      icon={<Trash2 size={16} strokeWidth={1.5} />}
                      onClick={() => {
                        setResult(null);
                        focusNext.current = "add";
                        setSaid(t("scheduling.wellbeing.form.removed", { n }));
                        setRows((current) => current.filter((r) => r.key !== row.key));
                      }}
                    >
                      {t("scheduling.wellbeing.form.removeQuestion", { n })}
                    </Button>
                  </div>
                ) : null}
              </fieldset>
            </li>
          );
        })}
      </ol>
      {rows.length < MAX_QUESTIONS ? (
        <div>
          <Button
            ref={addButton}
            variant="secondary"
            icon={<Plus size={16} strokeWidth={1.5} />}
            onClick={() => {
              setResult(null);
              focusNext.current = `survey-q-${rows.length + 1}-text`;
              setRows((current) => [...current, newRow()]);
            }}
          >
            {t("scheduling.wellbeing.form.addQuestion")}
          </Button>
        </div>
      ) : (
        <p className="m-0">{t("scheduling.wellbeing.form.maxQuestions", { max: MAX_QUESTIONS })}</p>
      )}
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      <div>
        <Button type="submit" disabled={pending}>
          {t("scheduling.wellbeing.form.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("scheduling.wellbeing.form.done")}
        fieldIds={fieldIds}
      />
    </form>
  );
}

/** Open a draft, or close an open survey: each asks first and cannot be undone. */
export function SurveyMove({
  surveyId,
  move,
  version,
}: {
  readonly surveyId: string;
  readonly move: "open" | "close";
  readonly version: number;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) cancel.current?.focus();
  }, [asking]);
  return (
    <div className="flex flex-col gap-3">
      {asking ? (
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="m-0 font-semibold">
            {t("scheduling.wellbeing.survey.moveQuestion", { move })}
          </legend>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const outcome = await moveSurvey({ surveyId, move, version });
                  setResult(outcome);
                  if (outcome.ok) {
                    router.push(`/wellbeing/surveys/${surveyId}?done=${move}`, { scroll: false });
                  }
                })
              }
            >
              {t("scheduling.wellbeing.survey.move", { move })}
            </Button>
            <Button
              ref={cancel}
              variant="secondary"
              onClick={() => {
                setAsking(false);
                window.setTimeout(() => trigger.current?.focus(), 0);
              }}
            >
              {t("scheduling.wellbeing.survey.keep", { move })}
            </Button>
          </div>
        </fieldset>
      ) : (
        <div>
          <Button ref={trigger} onClick={() => setAsking(true)}>
            {t("scheduling.wellbeing.survey.move", { move })}
          </Button>
        </div>
      )}
      <FormFeedback result={result} success={t("scheduling.wellbeing.survey.moved", { move })} />
    </div>
  );
}

/**
 * The anonymous answer form. Every question is optional, but at least one must be answered. The
 * answer is sent with nothing about the person, and the page that follows says it was received.
 */
export function AnswerForm({
  surveyId,
  questions,
}: {
  readonly surveyId: string;
  readonly questions: readonly SurveyQuestion[];
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const fieldIds = useMemo(
    () => Object.fromEntries(questions.map((q) => [`answer-${q.id}`, `answer-${q.id}`])),
    [questions],
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readAnswers(new FormData(event.currentTarget), questions, t);
    if (!read.ok) {
      setResult(collectedRefusal(read.problems));
      return;
    }
    startTransition(async () => {
      const outcome = await answerSurvey({ surveyId, answers: read.answers });
      setResult(outcome);
      if (outcome.ok) router.push("/wellbeing?done=answered", { scroll: false });
    });
  };
  return (
    <form method="post" className="flex flex-col gap-6" onSubmit={submit} noValidate>
      {questions.map((q, index) =>
        q.kind === "scale" ? (
          <RadioGroup
            key={q.id}
            id={`answer-${q.id}`}
            name={`answer-${q.id}`}
            legend={t("scheduling.wellbeing.answer.legend", { n: index + 1, text: q.text })}
            hint={t("scheduling.wellbeing.answer.scaleHint")}
            layout="inline"
            options={SCALE_POINTS.map((point) => ({
              value: String(point),
              label: t("scheduling.wellbeing.answer.point", { point }),
              ...(point === 1 || point === 5
                ? { description: t("scheduling.wellbeing.answer.pointEnd", { point }) }
                : {}),
            }))}
            error={errorFor(result, `answer-${q.id}`)}
          />
        ) : (
          <TextArea
            key={q.id}
            id={`answer-${q.id}`}
            name={`answer-${q.id}`}
            label={t("scheduling.wellbeing.answer.legend", { n: index + 1, text: q.text })}
            hint={t("scheduling.wellbeing.answer.textHint")}
            rows={3}
            maxLength={2000}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, `answer-${q.id}`)}
          />
        ),
      )}
      <div>
        <Button type="submit" icon={<Send size={16} strokeWidth={1.5} />} disabled={pending}>
          {t("scheduling.wellbeing.answer.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("scheduling.wellbeing.answer.done")}
        fieldIds={fieldIds}
      />
    </form>
  );
}

const THANKS_FIELDS = ["locationId", "toMemberId", "message"] as const;

/** Thank a colleague at a home where you both work. */
export function ThanksForm({
  places,
  place: chosen,
  colleagues,
}: {
  readonly places: readonly Option[];
  /** The home whose colleagues are listed; null until one is chosen. */
  readonly place: string | null;
  /** The colleagues at that home. */
  readonly colleagues: readonly Option[];
}) {
  const router = useRouter();
  const ids = useFieldIds(THANKS_FIELDS);
  const place = chosen ?? "";
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const [formKey, setFormKey] = useState(0);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const toMemberId = String(data.get("toMemberId") ?? "");
    const message = String(data.get("message") ?? "").trim();
    const problems = [
      ...(place
        ? []
        : [{ field: "locationId", message: t("scheduling.wellbeing.thanks.whereRequired") }]),
      ...(toMemberId
        ? []
        : [{ field: "toMemberId", message: t("scheduling.wellbeing.thanks.colleagueRequired") }]),
      ...(message.length === 0
        ? [{ field: "message", message: t("scheduling.wellbeing.thanks.messageRequired") }]
        : message.length > 500
          ? [{ field: "message", message: t("scheduling.wellbeing.thanks.messageTooLong") }]
          : []),
    ];
    const refusal = collectedRefusal(problems);
    if (refusal) {
      setResult(refusal);
      return;
    }
    startTransition(async () => {
      const outcome = await thankColleague({ toMemberId, locationId: place, message });
      setResult(outcome);
      if (outcome.ok) {
        setFormKey((k) => k + 1);
        router.refresh();
      }
    });
  };
  return (
    <form key={formKey} method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {places.length > 1 ? (
        <SelectField
          id={ids.locationId}
          name="locationId"
          label={t("scheduling.wellbeing.thanks.where")}
          emptyOption={t("scheduling.wellbeing.form.chooseWhere")}
          options={places}
          value={place}
          onChange={(event) => {
            // Reads that home's colleagues; the page keeps its place.
            const next = event.currentTarget.value;
            router.replace(next ? `/wellbeing?thanksAt=${next}#thanks` : "/wellbeing#thanks", {
              scroll: false,
            });
          }}
          error={errorFor(result, "locationId")}
        />
      ) : null}
      <SelectField
        id={ids.toMemberId}
        name="toMemberId"
        label={t("scheduling.wellbeing.thanks.colleague")}
        emptyOption={t("scheduling.wellbeing.thanks.chooseColleague")}
        options={colleagues}
        error={errorFor(result, "toMemberId")}
      />
      <TextArea
        id={ids.message}
        name="message"
        label={t("scheduling.wellbeing.thanks.message")}
        hint={t("scheduling.wellbeing.thanks.messageHint")}
        rows={3}
        maxLength={500}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "message")}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {t("scheduling.wellbeing.thanks.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("scheduling.wellbeing.thanks.done")}
        fieldIds={ids}
      />
    </form>
  );
}

const CHECK_IN_FIELDS = ["locationId", "mood", "note", "share"] as const;

/**
 * Record your own check-in. Private unless you tick to share it with your manager; the box is
 * never ticked for you.
 */
export function CheckInForm({ places }: { readonly places: readonly Option[] }) {
  const router = useRouter();
  const ids = useFieldIds(CHECK_IN_FIELDS);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const [formKey, setFormKey] = useState(0);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const locationId =
      places.length === 1 ? (places[0]?.value ?? "") : String(data.get("locationId") ?? "");
    const mood = Number(data.get("mood") ?? 0);
    const note = String(data.get("note") ?? "");
    const problems = [
      ...(locationId
        ? []
        : [{ field: "locationId", message: t("scheduling.wellbeing.checkIn.whereRequired") }]),
      ...(MOODS.includes(mood as (typeof MOODS)[number])
        ? []
        : [{ field: "mood", message: t("scheduling.wellbeing.checkIn.moodRequired") }]),
      ...(note.trim().length <= 1000
        ? []
        : [{ field: "note", message: t("scheduling.wellbeing.checkIn.noteTooLong") }]),
    ];
    const refusal = collectedRefusal(problems);
    if (refusal) {
      setResult(refusal);
      return;
    }
    startTransition(async () => {
      const outcome = await recordCheckIn({
        locationId,
        mood,
        note,
        share: data.get("share") === "yes",
      });
      setResult(outcome);
      if (outcome.ok) {
        setFormKey((k) => k + 1);
        router.refresh();
      }
    });
  };
  return (
    <form key={formKey} method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {places.length > 1 ? (
        <SelectField
          id={ids.locationId}
          name="locationId"
          label={t("scheduling.wellbeing.checkIn.where")}
          emptyOption={t("scheduling.wellbeing.form.chooseWhere")}
          options={places}
          error={errorFor(result, "locationId")}
        />
      ) : null}
      <RadioGroup
        id={ids.mood}
        name="mood"
        legend={t("scheduling.wellbeing.checkIn.mood")}
        hint={t("scheduling.wellbeing.checkIn.moodHint")}
        options={MOODS.map((mood) => ({
          value: String(mood),
          label: t("scheduling.wellbeing.mood", { mood }),
        }))}
        error={errorFor(result, "mood")}
      />
      <TextArea
        id={ids.note}
        name="note"
        label={t("scheduling.wellbeing.checkIn.note")}
        hint={t("scheduling.wellbeing.checkIn.noteHint")}
        rows={3}
        maxLength={1000}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "note")}
      />
      <Checkbox
        id={ids.share}
        name="share"
        value="yes"
        label={t("scheduling.wellbeing.checkIn.share")}
        hint={t("scheduling.wellbeing.checkIn.shareHint")}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {t("scheduling.wellbeing.checkIn.submit")}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("scheduling.wellbeing.checkIn.done")}
        fieldIds={ids}
      />
    </form>
  );
}

/** Share a check-in with your manager, or stop sharing it. */
export function ShareToggle({
  checkInId,
  shared,
  describedBy,
}: {
  readonly checkInId: string;
  readonly shared: boolean;
  /** The id of the check-in's line, so each button says which check-in it changes. */
  readonly describedBy: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  // The state the last change made, kept so the message stays right after the page reads again.
  const [made, setMade] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          aria-describedby={describedBy}
          aria-disabled={pending || undefined}
          onClick={() => {
            if (pending) return;
            const next = !shared;
            startTransition(async () => {
              const outcome = await shareCheckIn({ checkInId, shared: next });
              setResult(outcome.ok ? outcome : refused(outcome.message, outcome.code));
              if (outcome.ok) {
                setMade(next);
                router.refresh();
              }
            });
          }}
        >
          {t("scheduling.wellbeing.checkIn.toggle", { shared: shared ? "yes" : "no" })}
        </Button>
      </div>
      <FormFeedback
        result={result}
        success={t("scheduling.wellbeing.checkIn.toggled", { now: made ? "shared" : "private" })}
      />
    </div>
  );
}
