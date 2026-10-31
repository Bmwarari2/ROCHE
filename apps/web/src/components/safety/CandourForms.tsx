"use client";

import type { CandourItem } from "@harbour/contracts";
import {
  Button,
  Checkbox,
  DateTimeInput,
  type DateTimePart,
  dateTimePartsAt,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import {
  type CandourChange,
  reopenCandour,
  saveCandour,
  stepCandour,
} from "@/app/actions/incident-follow-up";
import { useFieldIds } from "@/components/care/form-state";
import { Notice } from "@/components/care/Notice";
import {
  CANDOUR_LIMITS,
  type CandourDocument,
  type CandourForm,
  type CandourStepOffer,
  DISAGREE_REASON_MIN,
  type HarbourFinding,
  readAttemptForm,
  readFollowUpForm,
  readThresholdForm,
  readVerbalForm,
  readWrittenForm,
  thresholdDisagrees,
} from "@/lib/candour";
import { formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import { boxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";
import { ManageFeedback, ReasonForm, useManageSend } from "./ManageForms";

type Mode = "keep" | "now" | "earlier";

/**
 * When something happened, chosen every time (HZ-090): as already recorded (when it was), just
 * now (the time Harbour receives the form) or earlier with the date and time, UK time on the
 * 24-hour clock. Nothing is chosen until the person chooses, so no time is assumed.
 */
function MomentField({
  name,
  legend,
  hint,
  id,
  recorded,
  error,
  errorParts,
  subject,
}: {
  readonly name: string;
  readonly legend: string;
  readonly hint: string;
  readonly id: string;
  /** The time already recorded, offered to keep. */
  readonly recorded: string | null;
  readonly error?: string;
  readonly errorParts?: readonly string[];
  /** What the earlier time is ("the time they were told"), for the second line of "earlier". */
  readonly subject: string;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [start, setStart] = useState<Record<DateTimePart, string> | null>(null);
  const boxes = boxesOf(errorParts);
  const recordedWords = formatDateTime(recorded);
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup<Mode>
        legend={legend}
        hint={hint}
        name={`${name}-mode`}
        layout="stack"
        value={mode}
        required
        onValueChange={(next) => {
          if (next === "earlier" && start === null) {
            setStart(dateTimePartsAt(recorded ? Date.parse(recorded) : Date.now()));
          }
          setMode(next);
        }}
        {...(mode !== "earlier" ? { id } : {})}
        {...(mode !== "earlier" && error ? { error } : {})}
        options={[
          ...(recorded && recordedWords
            ? [
                {
                  value: "keep" as const,
                  label: t("safety.candour.when", { when: "keep" }),
                  description: recordedWords,
                },
              ]
            : []),
          {
            value: "now" as const,
            label: t("safety.record.when", { when: "now" }),
            description: t("safety.candour.whenNow"),
          },
          {
            value: "earlier" as const,
            label: t("safety.record.when", { when: "earlier" }),
            description: subject,
          },
        ]}
      />
      {mode === "earlier" ? (
        <DateTimeInput
          legend={t("care.when.enter")}
          hint={t("care.when.hint")}
          name={name}
          id={id}
          defaultValue={start}
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          {...(error ? { error, ...(boxes ? { errorParts: boxes } : {}) } : {})}
        />
      ) : null}
    </div>
  );
}

/** A yes or no question with nothing chosen until the person chooses (HZ-090). */
function YesNo({
  name,
  legend,
  hint,
  id,
  error,
  value,
  onAnswer,
}: {
  readonly name: string;
  readonly legend: string;
  readonly hint?: string;
  readonly id: string;
  readonly error?: string;
  readonly value?: boolean | null;
  /** Called with the answer as it is chosen. */
  readonly onAnswer?: (answer: boolean) => void;
}) {
  return (
    <RadioGroup<"yes" | "no">
      legend={legend}
      name={name}
      id={id}
      layout="inline"
      required
      {...(onAnswer ? { onValueChange: (next: "yes" | "no") => onAnswer(next === "yes") } : {})}
      {...(hint ? { hint } : {})}
      {...(error ? { error } : {})}
      {...(value === true
        ? { defaultValue: "yes" }
        : value === false
          ? { defaultValue: "no" }
          : {})}
      options={[
        { value: "yes", label: t("safety.questions.answer", { answer: "yes" }) },
        { value: "no", label: t("safety.questions.answer", { answer: "no" }) },
      ]}
    />
  );
}

/** Ticked statements in one question: what the person was told, or what the letter included. */
function Ticks({
  legend,
  hint,
  boxes,
}: {
  readonly legend: string;
  readonly hint: string;
  readonly boxes: readonly {
    readonly name: string;
    readonly label: string;
    readonly on: boolean;
  }[];
}) {
  const hintId = useId();
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" aria-describedby={hintId}>
      <legend className="mb-1 p-0 font-semibold">{legend}</legend>
      <p id={hintId} className="hb-field__hint m-0">
        {hint}
      </p>
      {boxes.map((box) => (
        <Checkbox
          key={box.name}
          name={box.name}
          value="yes"
          label={box.label}
          defaultChecked={box.on}
        />
      ))}
    </fieldset>
  );
}

/** Where the documents come from, and why none is offered when none is. */
export interface DocumentChoice {
  readonly offered: readonly CandourDocument[];
  /** Why the list is empty: no relevant person yet, none on their record, or not shown to you. */
  readonly empty: "noPerson" | "none" | "hidden" | null;
  /** The relevant person, for the hints ("on their record"). */
  readonly name: string | null;
  /** Their letters page, for someone who sends letters. */
  readonly lettersHref: string | null;
}

/** Why no document is offered, and where letters are sent from. */
function DocumentsNote({ documents }: { readonly documents: DocumentChoice }) {
  return (
    <p className="m-0 text-body-dense text-text-secondary">
      {t("safety.candour.documentsNote", {
        reason: documents.empty ?? "some",
        name: documents.name ?? "none",
      })}
      {documents.lettersHref ? (
        <>
          {" "}
          <Link href={documents.lettersHref} className="underline">
            {t("safety.candour.lettersLink")}
          </Link>
        </>
      ) : null}
    </p>
  );
}

/** One document chosen from the relevant person's record, or none yet. */
function DocumentSelect({
  name,
  label,
  id,
  documents,
  current,
}: {
  readonly name: string;
  readonly label: string;
  readonly id: string;
  readonly documents: DocumentChoice;
  readonly current: string | null;
}) {
  const options = documents.offered.map((d) => ({ value: d.id, label: d.label }));
  // A document already kept stays chosen, even when the list no longer offers it.
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: t("safety.candour.documentKept") });
  }
  return (
    <div className="flex flex-col gap-2">
      {options.length > 0 ? (
        <SelectField
          id={id}
          name={name}
          label={label}
          hint={t("safety.candour.documentHint")}
          emptyOption={t("safety.candour.noDocument")}
          options={options}
          defaultValue={current ?? ""}
        />
      ) : (
        <p className="m-0 font-semibold">{label}</p>
      )}
      <DocumentsNote documents={documents} />
    </div>
  );
}

/** A form's title and the words under it. */
function FormHeading({
  id,
  title,
  intro,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 id={id} className="m-0 text-body font-semibold">
        {title}
      </h3>
      <p className="m-0 max-w-prose text-body-dense text-text-secondary">{intro}</p>
    </div>
  );
}

interface Target {
  readonly incidentId: string;
  /** The record's version, or 0 when there is none yet. */
  readonly version: number;
}

const pathOf = (incidentId: string) => `/incidents/${incidentId}`;

/** Sends one part of the candour record and opens the page again, saying it was saved. */
function useCandourSave(target: Target) {
  const path = pathOf(target.incidentId);
  const manage = useManageSend(path);
  const save = (change: CandourChange, done: "candourSaved" | "candourMoved" = "candourSaved") =>
    manage.send(done, () => saveCandour(target.incidentId, change, target.version));
  return { ...manage, save, path };
}

function SaveButton({ pending, label }: { readonly pending: boolean; readonly label: string }) {
  return (
    <div>
      <Button type="submit" disabled={pending}>
        {pending ? t("common.saving") : label}
      </Button>
    </div>
  );
}

const THRESHOLD_FIELDS = [
  "personId",
  "notifiable",
  "decidedAt",
  "decidedBy",
  "confirm",
  "reason",
] as const;

/** The threshold decision (regulation 20(9)) and who it happened to. */
function ThresholdForm({
  target,
  record,
  people,
  finding,
  prolongedDays,
}: {
  readonly target: Target;
  readonly record: CandourItem | null;
  readonly people: readonly { readonly value: string; readonly label: string }[];
  /** What Harbour found on the answers recorded, or null once a decision is recorded. */
  readonly finding: HarbourFinding | null;
  /** `candour.prolonged_harm_days` from the rate table, for the question's hint. */
  readonly prolongedDays?: number;
}) {
  const ids = useFieldIds(THRESHOLD_FIELDS);
  const { result, pending, fail, save, path } = useCandourSave(target);
  const [answer, setAnswer] = useState<boolean | null>(record?.threshold?.notifiable ?? null);
  const disagrees =
    answer !== null && thresholdDisagrees(answer, finding, record?.threshold ?? null);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readThresholdForm(
      new FormData(event.currentTarget),
      people.map((p) => p.value),
      record?.threshold ?? null,
      new Date(),
      t,
      finding,
    );
    if (!read.ok) return fail(read.errors, read.parts);
    save({ part: "threshold", input: read.input }, read.input.reason ? "candourMoved" : undefined);
  };
  const current = record?.personId ?? (people.length === 1 ? (people[0]?.value ?? null) : null);
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="candour-threshold"
      >
        <FormHeading
          id="candour-threshold"
          title={t("safety.candour.formTitle", { form: "threshold" })}
          intro={t("safety.candour.formIntro", { form: "threshold" })}
        />
        {people.length > 0 ? (
          <RadioGroup<string>
            id={ids.personId}
            name="personId"
            legend={t("safety.candour.label", { field: "personId" })}
            hint={t("safety.candour.hint", { field: "personId" })}
            required
            {...(current ? { defaultValue: current } : {})}
            {...(errorFor(result, "personId") ? { error: errorFor(result, "personId") } : {})}
            options={people}
          />
        ) : null}
        {finding ? (
          <p className="m-0 flex items-start gap-2">
            <Info size={18} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
            {t("safety.candour.finding", { finding })}
          </p>
        ) : null}
        <YesNo
          name="notifiable"
          id={ids.notifiable}
          legend={t("safety.candour.label", { field: "notifiable" })}
          hint={t("safety.candour.notifiableHint", { days: prolongedDays ?? "none" })}
          value={record?.threshold?.notifiable ?? null}
          onAnswer={setAnswer}
          {...(errorFor(result, "notifiable") ? { error: errorFor(result, "notifiable") } : {})}
        />
        {disagrees ? (
          // A decision that differs from Harbour's finding, or changes one, is confirmed with a
          // reason kept with the record, and moves the record on at once (review M4; H-265).
          <div className="flex flex-col gap-4 border-s-4 border-warning ps-4">
            <p className="m-0 flex items-start gap-2 font-semibold">
              <CircleAlert
                size={18}
                strokeWidth={1.5}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              {t("safety.candour.disagree", {
                kind: record?.threshold ? "change" : (finding ?? "none"),
              })}
            </p>
            <TextArea
              id={ids.reason}
              name="reason"
              label={t("safety.candour.label", { field: "disagreeReason" })}
              hint={t("safety.candour.hint", { field: "disagreeReason" })}
              rows={3}
              required
              maxLength={CANDOUR_LIMITS.reason}
              formatCount={(remaining) => characterCount(remaining)}
              {...(errorFor(result, "reason") ? { error: errorFor(result, "reason") } : {})}
            />
            <Checkbox
              id={ids.confirm}
              name="confirm"
              value="yes"
              label={t("safety.candour.confirm")}
              required
              {...(errorFor(result, "confirm") ? { error: errorFor(result, "confirm") } : {})}
            />
          </div>
        ) : null}
        <MomentField
          name="decidedAt"
          id={ids.decidedAt}
          legend={t("safety.candour.label", { field: "decidedAt" })}
          hint={t("safety.candour.hint", { field: "when" })}
          subject={t("safety.candour.whenEarlier", { field: "decidedAt" })}
          recorded={record?.threshold?.decidedAt ?? null}
          {...(errorFor(result, "decidedAt") ? { error: errorFor(result, "decidedAt") } : {})}
          {...(partsFor(result, "decidedAt") ? { errorParts: partsFor(result, "decidedAt") } : {})}
        />
        <TextField
          id={ids.decidedBy}
          name="decidedBy"
          label={t("safety.candour.label", { field: "decidedBy" })}
          hint={t("safety.candour.hint", { field: "decidedBy" })}
          required
          maxLength={CANDOUR_LIMITS.decidedBy}
          autoComplete="off"
          defaultValue={record?.threshold?.decidedBy ?? ""}
          {...(errorFor(result, "decidedBy") ? { error: errorFor(result, "decidedBy") } : {})}
        />
        <SaveButton pending={pending} label={t("safety.candour.save", { form: "threshold" })} />
      </form>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

const VERBAL_FIELDS = ["at", "byRepresentatives", "inPerson", "writtenRecordId"] as const;

/** Telling the person in person (regulation 20(2) and (3)). */
function VerbalForm({
  target,
  record,
  documents,
}: {
  readonly target: Target;
  readonly record: CandourItem;
  readonly documents: DocumentChoice;
}) {
  const ids = useFieldIds(VERBAL_FIELDS);
  const { result, pending, fail, save, path } = useCandourSave(target);
  const verbal = record.verbal;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readVerbalForm(
      new FormData(event.currentTarget),
      documents.offered,
      verbal,
      new Date(),
      t,
    );
    if (!read.ok) return fail(read.errors, read.parts);
    save({ part: "verbal", input: read.input });
  };
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="candour-verbal"
      >
        <FormHeading
          id="candour-verbal"
          title={t("safety.candour.formTitle", { form: "verbal" })}
          intro={t("safety.candour.formIntro", { form: "verbal" })}
        />
        <MomentField
          name="at"
          id={ids.at}
          legend={t("safety.candour.label", { field: "toldAt" })}
          hint={t("safety.candour.hint", { field: "when" })}
          subject={t("safety.candour.whenEarlier", { field: "toldAt" })}
          recorded={verbal?.at ?? null}
          {...(errorFor(result, "at") ? { error: errorFor(result, "at") } : {})}
          {...(partsFor(result, "at") ? { errorParts: partsFor(result, "at") } : {})}
        />
        <TextArea
          id={ids.byRepresentatives}
          name="byRepresentatives"
          label={t("safety.candour.label", { field: "byRepresentatives" })}
          hint={t("safety.candour.hint", { field: "byRepresentatives" })}
          rows={3}
          required
          defaultValue={(verbal?.byRepresentatives ?? []).join("\n")}
          {...(errorFor(result, "byRepresentatives")
            ? { error: errorFor(result, "byRepresentatives") }
            : {})}
        />
        <YesNo
          name="inPerson"
          id={ids.inPerson}
          legend={t("safety.candour.label", { field: "inPerson" })}
          hint={t("safety.candour.hint", { field: "inPerson" })}
          value={verbal?.inPerson ?? null}
          {...(errorFor(result, "inPerson") ? { error: errorFor(result, "inPerson") } : {})}
        />
        <Ticks
          legend={t("safety.candour.label", { field: "told" })}
          hint={t("safety.candour.hint", { field: "told" })}
          boxes={[
            {
              name: "accountGiven",
              label: t("safety.candour.item", { item: "account" }),
              on: verbal?.accountGiven ?? false,
            },
            {
              name: "enquiriesAdvised",
              label: t("safety.candour.item", { item: "enquiriesAdvised" }),
              on: verbal?.enquiriesAdvised ?? false,
            },
            {
              name: "apologyGiven",
              label: t("safety.candour.item", { item: "apology" }),
              on: verbal?.apologyGiven ?? false,
            },
          ]}
        />
        <DocumentSelect
          name="writtenRecordId"
          id={ids.writtenRecordId}
          label={t("safety.candour.label", { field: "writtenRecordId" })}
          documents={documents}
          current={verbal?.writtenRecordId ?? null}
        />
        <SaveButton pending={pending} label={t("safety.candour.save", { form: "verbal" })} />
      </form>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

const ATTEMPT_FIELDS = ["attemptAt", "note"] as const;

/** One attempt to contact or speak to the person (regulation 20(5)(b)). */
function AttemptForm({
  target,
  record,
}: {
  readonly target: Target;
  readonly record: CandourItem;
}) {
  const ids = useFieldIds(ATTEMPT_FIELDS);
  const { result, pending, fail, save, path } = useCandourSave(target);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readAttemptForm(new FormData(event.currentTarget), new Date(), t);
    if (!read.ok) return fail(read.errors, read.parts);
    save({ part: "attempt", input: read.input, previous: record.contactAttempts });
  };
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="candour-attempt"
      >
        <FormHeading
          id="candour-attempt"
          title={t("safety.candour.formTitle", { form: "attempt" })}
          intro={t("safety.candour.formIntro", { form: "attempt" })}
        />
        <MomentField
          name="attemptAt"
          id={ids.attemptAt}
          legend={t("safety.candour.label", { field: "attemptAt" })}
          hint={t("safety.candour.hint", { field: "when" })}
          subject={t("safety.candour.whenEarlier", { field: "attemptAt" })}
          recorded={null}
          {...(errorFor(result, "attemptAt") ? { error: errorFor(result, "attemptAt") } : {})}
          {...(partsFor(result, "attemptAt") ? { errorParts: partsFor(result, "attemptAt") } : {})}
        />
        <TextArea
          id={ids.note}
          name="note"
          label={t("safety.candour.label", { field: "note" })}
          hint={t("safety.candour.hint", { field: "note" })}
          rows={3}
          required
          maxLength={CANDOUR_LIMITS.attemptNote}
          formatCount={(remaining) => characterCount(remaining)}
          {...(errorFor(result, "note") ? { error: errorFor(result, "note") } : {})}
        />
        <SaveButton pending={pending} label={t("safety.candour.save", { form: "attempt" })} />
      </form>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

const WRITTEN_FIELDS = ["sentAt", "documentId"] as const;

/** The written notification (regulation 20(4)) and its copy (20(6)). */
function WrittenForm({
  target,
  record,
  documents,
}: {
  readonly target: Target;
  readonly record: CandourItem;
  readonly documents: DocumentChoice;
}) {
  const ids = useFieldIds(WRITTEN_FIELDS);
  const { result, pending, fail, save, path } = useCandourSave(target);
  const written = record.written;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readWrittenForm(
      new FormData(event.currentTarget),
      documents.offered,
      written,
      new Date(),
      t,
    );
    if (!read.ok) return fail(read.errors, read.parts);
    save({ part: "written", input: read.input });
  };
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="candour-written"
      >
        <FormHeading
          id="candour-written"
          title={t("safety.candour.formTitle", { form: "written" })}
          intro={t("safety.candour.formIntro", { form: "written" })}
        />
        <MomentField
          name="sentAt"
          id={ids.sentAt}
          legend={t("safety.candour.label", { field: "sentAt" })}
          hint={t("safety.candour.hint", { field: "when" })}
          subject={t("safety.candour.whenEarlier", { field: "sentAt" })}
          recorded={written?.sentAt ?? null}
          {...(errorFor(result, "sentAt") ? { error: errorFor(result, "sentAt") } : {})}
          {...(partsFor(result, "sentAt") ? { errorParts: partsFor(result, "sentAt") } : {})}
        />
        <Ticks
          legend={t("safety.candour.label", { field: "included" })}
          hint={t("safety.candour.hint", { field: "included" })}
          boxes={[
            {
              name: "includesAccount",
              label: t("safety.candour.item", { item: "account" }),
              on: written?.includesAccount ?? false,
            },
            {
              name: "includesEnquiries",
              label: t("safety.candour.item", { item: "enquiries" }),
              on: written?.includesEnquiries ?? false,
            },
            {
              name: "includesApology",
              label: t("safety.candour.item", { item: "apology" }),
              on: written?.includesApology ?? false,
            },
          ]}
        />
        <DocumentSelect
          name="documentId"
          id={ids.documentId}
          label={t("safety.candour.label", { field: "documentId" })}
          documents={documents}
          current={written?.documentId ?? null}
        />
        <SaveButton pending={pending} label={t("safety.candour.save", { form: "written" })} />
      </form>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

const FOLLOW_UP_FIELDS = ["resultsSharedAt", "correspondence", "outcome"] as const;

/** The results of the enquiries, the correspondence kept and the outcome (20(4)(c) and (6)). */
function FollowUpForm({
  target,
  record,
  documents,
}: {
  readonly target: Target;
  readonly record: CandourItem;
  readonly documents: DocumentChoice;
}) {
  const ids = useFieldIds(FOLLOW_UP_FIELDS);
  const { result, pending, fail, save, path } = useCandourSave(target);
  const hintId = useId();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readFollowUpForm(
      new FormData(event.currentTarget),
      documents.offered,
      record.correspondenceDocumentIds,
      new Date(),
      t,
    );
    if (!read.ok) return fail(read.errors, read.parts);
    save({ part: "followUp", input: read.input });
  };
  const shared = record.enquiryResultsSharedAt;
  const boxes = boxesOf(partsFor(result, "resultsSharedAt"));
  const sharedError = errorFor(result, "resultsSharedAt");
  const kept = record.correspondenceDocumentIds.filter(
    (id) => !documents.offered.some((d) => d.id === id),
  );
  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="candour-follow-up"
      >
        <FormHeading
          id="candour-follow-up"
          title={t("safety.candour.formTitle", { form: "followUp" })}
          intro={t("safety.candour.formIntro", { form: "followUp" })}
        />
        <DateTimeInput
          legend={t("safety.candour.label", { field: "resultsSharedAt" })}
          hint={t("safety.candour.hint", { field: "resultsSharedAt" })}
          name="resultsSharedAt"
          id={ids.resultsSharedAt}
          defaultValue={shared ? dateTimePartsAt(Date.parse(shared)) : null}
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          {...(sharedError ? { error: sharedError, ...(boxes ? { errorParts: boxes } : {}) } : {})}
        />
        <fieldset
          className="m-0 flex flex-col gap-1 border-0 p-0"
          aria-describedby={hintId}
          id={ids.correspondence}
        >
          <legend className="mb-1 p-0 font-semibold">
            {t("safety.candour.label", { field: "correspondence" })}
          </legend>
          <p id={hintId} className="hb-field__hint m-0">
            {t("safety.candour.hint", { field: "correspondence" })}
          </p>
          {kept.map((id) => (
            <Checkbox
              key={id}
              name="correspondence"
              value={id}
              label={t("safety.candour.documentKept")}
              defaultChecked
            />
          ))}
          {documents.offered.map((d) => (
            <Checkbox
              key={d.id}
              name="correspondence"
              value={d.id}
              label={d.label}
              defaultChecked={record.correspondenceDocumentIds.includes(d.id)}
            />
          ))}
          <DocumentsNote documents={documents} />
        </fieldset>
        <TextArea
          id={ids.outcome}
          name="outcome"
          label={t("safety.candour.label", { field: "outcome" })}
          hint={t("safety.candour.hint", { field: "outcome" })}
          rows={3}
          maxLength={CANDOUR_LIMITS.outcome}
          formatCount={(remaining) => characterCount(remaining)}
          defaultValue={record.outcome ?? ""}
          {...(errorFor(result, "outcome") ? { error: errorFor(result, "outcome") } : {})}
        />
        <SaveButton pending={pending} label={t("safety.candour.save", { form: "followUp" })} />
      </form>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

/** A step with no reason: one button, as the workflow asks nothing more. */
function StepButton({
  target,
  offer,
}: {
  readonly target: Target;
  readonly offer: CandourStepOffer;
}) {
  const path = pathOf(target.incidentId);
  const { result, pending, send } = useManageSend(path);
  const titleId = useId();
  return (
    <div className="flex flex-col gap-2">
      <h3 id={titleId} className="m-0 text-body font-semibold">
        {t("safety.candour.stepTitle", { to: offer.to })}
      </h3>
      <p className="m-0 max-w-prose text-body-dense text-text-secondary">
        {t("safety.candour.stepIntro", { to: offer.to })}
      </p>
      <div>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            send("candourMoved", () =>
              stepCandour(target.incidentId, {
                to: offer.to as Parameters<typeof stepCandour>[1]["to"],
                version: target.version,
              }),
            )
          }
        >
          {pending ? t("common.saving") : t("safety.candour.stepSubmit", { to: offer.to })}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} />
    </div>
  );
}

/** What a step still needs, listed, instead of a step the API would refuse (HZ-091). */
function StepNeeds({ offer }: { readonly offer: CandourStepOffer }) {
  return (
    <Notice
      icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
      title={t("safety.candour.stepNeeds", { to: offer.to })}
    >
      <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
        {offer.needs.map((need) => (
          <li key={need}>{need}</li>
        ))}
      </ul>
    </Notice>
  );
}

/**
 * The next steps of the record (`CANDOUR_WORKFLOW`): each offered only when nothing is missing
 * for it (`candourStepProblems`, as the API checks), with a reason where the workflow asks one;
 * otherwise what is missing, listed.
 */
function CandourSteps({
  target,
  steps,
}: {
  readonly target: Target;
  readonly steps: readonly CandourStepOffer[];
}) {
  const path = pathOf(target.incidentId);
  return (
    <div className="flex flex-col gap-6">
      {steps.map((offer): ReactNode => {
        if (offer.needs.length > 0) return <StepNeeds key={offer.to} offer={offer} />;
        if (!offer.needsReason) return <StepButton key={offer.to} target={target} offer={offer} />;
        return (
          <ReasonForm
            key={offer.to}
            title={t("safety.candour.stepTitle", { to: offer.to })}
            intro={t("safety.candour.stepIntro", { to: offer.to })}
            label={t("safety.candour.stepLabel", { to: offer.to })}
            hint={t("safety.candour.stepHint", { to: offer.to })}
            purpose="candour"
            submit={t("safety.candour.stepSubmit", { to: offer.to })}
            path={path}
            done="candourMoved"
            {...(offer.to === "not_notifiable" || offer.to === "no_contact"
              ? { destructive: true }
              : {})}
            {...(offer.strict
              ? { min: DISAGREE_REASON_MIN, confirm: t("safety.candour.confirm") }
              : {})}
            onSend={(reason) =>
              stepCandour(target.incidentId, {
                to: offer.to as Parameters<typeof stepCandour>[1]["to"],
                reason,
                // The form asked for the tick before sending (ReasonForm's `confirm`).
                ...(offer.strict ? { confirmed: true } : {}),
                version: target.version,
              })
            }
          />
        );
      })}
    </div>
  );
}

/**
 * The manager's forms on the duty of candour record (`safety.incident.manage`; safety.md rule 5;
 * SAFE-007; HZ-013, HZ-091): the forms for its stage (`candourForms`), then its next steps. Each
 * save sends the version the page was drawn from; the API checks every rule again.
 */
export function CandourForms({
  incidentId,
  record,
  forms,
  steps,
  people,
  documents,
  finding,
  prolongedDays,
}: {
  readonly incidentId: string;
  readonly record: CandourItem | null;
  readonly forms: readonly CandourForm[];
  readonly steps: readonly CandourStepOffer[];
  /** The people we support on the incident, for the relevant person. */
  readonly people: readonly { readonly value: string; readonly label: string }[];
  readonly documents: DocumentChoice;
  /** What Harbour found on the answers recorded, beside the threshold question. */
  readonly finding: HarbourFinding | null;
  /** `candour.prolonged_harm_days` from the rate table. */
  readonly prolongedDays?: number;
}) {
  const target = { incidentId, version: record?.version ?? 0 };
  return (
    <div className="flex flex-col gap-8">
      {steps.length > 0 ? <CandourSteps target={target} steps={steps} /> : null}
      {forms.includes("threshold") ? (
        <ThresholdForm
          target={target}
          record={record}
          people={people}
          finding={finding}
          {...(prolongedDays !== undefined ? { prolongedDays } : {})}
        />
      ) : null}
      {record && forms.includes("verbal") ? (
        <VerbalForm target={target} record={record} documents={documents} />
      ) : null}
      {record && forms.includes("attempt") ? <AttemptForm target={target} record={record} /> : null}
      {record && forms.includes("written") ? (
        <WrittenForm target={target} record={record} documents={documents} />
      ) : null}
      {record && forms.includes("followUp") ? (
        <FollowUpForm target={target} record={record} documents={documents} />
      ) : null}
      {record && forms.includes("reopen") ? (
        <ReasonForm
          title={t("safety.candour.reopen.title")}
          intro={t("safety.candour.reopen.intro", { state: record.state })}
          label={t("safety.candour.reopen.label")}
          hint={t("safety.candour.reopen.hint")}
          purpose="candourReopen"
          submit={t("safety.candour.reopen.submit")}
          path={pathOf(incidentId)}
          done="candourReopened"
          min={DISAGREE_REASON_MIN}
          onSend={(reason) => reopenCandour(incidentId, { reason, version: record.version })}
        />
      ) : null}
    </div>
  );
}
