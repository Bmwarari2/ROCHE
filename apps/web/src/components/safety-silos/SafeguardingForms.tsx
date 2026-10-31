"use client";

import type { SafeguardingState } from "@harbour/contracts";
import {
  Button,
  Checkbox,
  DateTimeInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { CircleAlert, CircleCheck, Save, Send, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  raiseSafeguardingConcern,
  stepSafeguardingConcern,
  updateSafeguardingConcern,
} from "@/app/actions/safety-silos";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { uuidv7 } from "@/lib/entry-id";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import {
  ABUSE_TYPES,
  ACHIEVED,
  DESCRIPTION_MAX,
  ENQUIRY_KINDS,
  FINDINGS,
  MEASURES_MAX,
  MEASURES_OUTCOMES,
  REFERRAL_METHODS,
  readRaiseConcern,
  readSafeguardingStep,
  readSafeguardingUpdate,
  STAFF_HARM,
} from "@/lib/safeguarding";
import { boxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";
import { useSubmit } from "./use-submit";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const choose = (list: readonly string[], key: string, none: string) => [
  { value: "", label: none },
  ...list.map((value) => ({ value, label: t(key as "safeguarding.finding", { value }) })),
];

/**
 * Raising a concern about a person: who, what kind of abuse, what happened, what keeps them safe.
 * Nobody is chosen until the raiser chooses (clinical review, finding 1). A manager of the log goes
 * on to the concern; anyone else stays here and is told it was raised, since they cannot open it.
 */
export function RaiseConcernForm({
  people,
  personId,
  canManage,
}: {
  readonly people: readonly {
    readonly id: string;
    readonly name: string;
    readonly label: string;
  }[];
  readonly personId: string | null;
  readonly canManage: boolean;
}) {
  const router = useRouter();
  const ids = useFieldIds(["personId", "abuseTypes", "description", "protectiveMeasures"]);
  const [raisedFor, setRaisedFor] = useState<{ id: string; name: string } | null>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (raisedFor) confirmation.current?.focus();
  }, [raisedFor]);
  const { submit, result, pending } = useSubmit(
    (form) =>
      readRaiseConcern(form, t, { id: uuidv7(), personId: String(form.get("personId") ?? "") }),
    raiseSafeguardingConcern,
    (data, form) => {
      const raised = data as { id?: string };
      if (canManage) {
        router.push(raised.id ? `/safeguarding/${raised.id}` : "/safeguarding");
        return;
      }
      const chosen = people.find((p) => p.id === String(new FormData(form).get("personId")));
      setRaisedFor(chosen ? { id: chosen.id, name: chosen.name } : null);
    },
  );
  if (raisedFor) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <h2
          ref={confirmation}
          tabIndex={-1}
          className="m-0 flex items-center gap-2 text-body font-semibold"
        >
          <CircleCheck {...icon} />
          {t("safeguarding.raised.title")}
        </h2>
        <p className="m-0">{t("safeguarding.raised.body")}</p>
        <p className="m-0">
          <Link
            href={`/people/${raisedFor.id}/safeguarding`}
            className="inline-flex min-h-target items-center underline"
          >
            {t("safeguarding.raised.back", { name: raisedFor.name })}
          </Link>
        </p>
      </div>
    );
  }
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.personId}
        name="personId"
        label={t("safeguarding.form.person")}
        hint={t("safeguarding.form.personHint")}
        defaultValue={personId ?? ""}
        emptyOption={t("safeguarding.form.personChoose")}
        options={people.map((p) => ({ value: p.id, label: p.label }))}
        error={errorFor(result, "personId")}
      />
      <fieldset
        className="m-0 flex flex-col gap-1 border-0 p-0"
        {...(errorFor(result, "abuseTypes")
          ? { "aria-describedby": `${ids.abuseTypes}-error` }
          : {})}
      >
        <legend className="mb-2 text-body font-semibold">
          {t("safeguarding.form.abuseTypes")}
        </legend>
        {errorFor(result, "abuseTypes") ? (
          <p
            id={`${ids.abuseTypes}-error`}
            className="m-0 flex items-center gap-2 text-body-dense font-semibold text-danger"
          >
            <CircleAlert {...icon} />
            {errorFor(result, "abuseTypes")}
          </p>
        ) : null}
        {ABUSE_TYPES.map((value, index) => (
          <Checkbox
            key={value}
            // The first box carries the field's id, so the error summary's link focuses it.
            {...(index === 0 ? { id: ids.abuseTypes } : {})}
            name="abuseTypes"
            value={value}
            label={t("safeguarding.abuseType", { value })}
            {...(errorFor(result, "abuseTypes") ? { "aria-invalid": true } : {})}
          />
        ))}
      </fieldset>
      <TextArea
        id={ids.description}
        name="description"
        label={t("safeguarding.form.description")}
        hint={t("safeguarding.form.descriptionHint")}
        rows={5}
        maxLength={DESCRIPTION_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "description")}
      />
      <TextArea
        id={ids.protectiveMeasures}
        name="protectiveMeasures"
        label={t("safeguarding.form.measures")}
        hint={t("safeguarding.form.measuresHint")}
        rows={3}
        maxLength={MEASURES_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "protectiveMeasures")}
      />
      <div>
        <Button type="submit" icon={<ShieldAlert {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("safeguarding.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("safeguarding.form.done")} fieldIds={ids} />
    </form>
  );
}

/** Recording the referral, enquiry, finding, outcomes, DBS decision and measures as they happen. */
export function UpdateConcernForm({
  id,
  version,
  protectiveMeasures,
  measuresOutcome,
}: {
  readonly id: string;
  readonly version: number;
  readonly protectiveMeasures: string | null;
  readonly measuresOutcome: string | null;
}) {
  const ids = useFieldIds([
    "localAuthority",
    "referralMethod",
    "referredAt",
    "referralReference",
    "enquiryKind",
    "enquiryOpenedAt",
    "finding",
    "staffHarm",
    "outcomesAsked",
    "desiredOutcomes",
    "notAskedReason",
    "achieved",
    "dbsDecision",
    "dbsReason",
    "protectiveMeasures",
    "measuresOutcome",
    "form",
  ]);
  const { submit, result, pending } = useSubmit(
    (form) => readSafeguardingUpdate(form, t, { version, savedMeasuresOutcome: measuresOutcome }),
    (body) => updateSafeguardingConcern(id, body),
  );
  const legend = "mb-2 text-body font-semibold";
  return (
    <form method="post" className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <p className="m-0" id={ids.form}>
        {t("safeguarding.update.intro")}
      </p>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className={legend}>{t("safeguarding.update.referral")}</legend>
        <TextField
          id={ids.localAuthority}
          name="localAuthority"
          label={t("safeguarding.update.authority")}
          autoComplete="off"
          error={errorFor(result, "localAuthority")}
        />
        <SelectField
          id={ids.referralMethod}
          name="referralMethod"
          label={t("safeguarding.update.method")}
          defaultValue=""
          options={choose(REFERRAL_METHODS, "safeguarding.method", t("safeguarding.update.choose"))}
          error={errorFor(result, "referralMethod")}
        />
        <DateTimeInput
          id={ids.referredAt}
          name="referredAt"
          legend={t("safeguarding.update.referredAt")}
          hint={t("care.when.hint")}
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          error={errorFor(result, "referredAt")}
          errorParts={boxesOf(partsFor(result, "referredAt"))}
        />
        <TextField
          id={ids.referralReference}
          name="referralReference"
          label={t("safeguarding.update.reference")}
          autoComplete="off"
        />
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className={legend}>{t("safeguarding.update.enquiry")}</legend>
        <SelectField
          id={ids.enquiryKind}
          name="enquiryKind"
          label={t("safeguarding.update.enquiryKind")}
          defaultValue=""
          options={choose(
            ENQUIRY_KINDS,
            "safeguarding.enquiryKind",
            t("safeguarding.update.choose"),
          )}
          error={errorFor(result, "enquiryKind")}
        />
        <DateTimeInput
          id={ids.enquiryOpenedAt}
          name="enquiryOpenedAt"
          legend={t("safeguarding.update.enquiryOpened")}
          hint={t("care.when.hint")}
          labels={dateTimeLabels(t)}
          repeated={ukRepeatedTime}
          error={errorFor(result, "enquiryOpenedAt")}
          errorParts={boxesOf(partsFor(result, "enquiryOpenedAt"))}
        />
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className={legend}>{t("safeguarding.update.outcome")}</legend>
        <SelectField
          id={ids.finding}
          name="finding"
          label={t("safeguarding.update.finding")}
          defaultValue=""
          options={choose(FINDINGS, "safeguarding.finding", t("safeguarding.update.choose"))}
        />
        <SelectField
          id={ids.staffHarm}
          name="staffHarm"
          label={t("safeguarding.update.staffHarm")}
          defaultValue=""
          options={choose(STAFF_HARM, "safeguarding.staffHarm", t("safeguarding.update.choose"))}
        />
        <RadioGroup
          id={ids.outcomesAsked}
          name="outcomesAsked"
          legend={t("safeguarding.update.asked")}
          options={[
            { value: "yes", label: t("safeguarding.update.askedYes") },
            { value: "no", label: t("safeguarding.update.askedNo") },
          ]}
        />
        <TextArea
          id={ids.desiredOutcomes}
          name="desiredOutcomes"
          label={t("safeguarding.update.desired")}
          rows={3}
          maxLength={MEASURES_MAX}
          formatCount={(remaining) => characterCount(remaining)}
        />
        <TextArea
          id={ids.notAskedReason}
          name="notAskedReason"
          label={t("safeguarding.update.notAsked")}
          rows={2}
          maxLength={MEASURES_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "notAskedReason")}
        />
        <SelectField
          id={ids.achieved}
          name="achieved"
          label={t("safeguarding.update.achieved")}
          defaultValue=""
          options={choose(ACHIEVED, "safeguarding.achieved", t("safeguarding.update.choose"))}
        />
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className={legend}>{t("safeguarding.update.dbs")}</legend>
        <RadioGroup
          id={ids.dbsDecision}
          name="dbsDecision"
          legend={t("safeguarding.update.dbsDecision")}
          options={[
            { value: "referred", label: t("safeguarding.update.dbsReferred") },
            { value: "not_required", label: t("safeguarding.update.dbsNotRequired") },
          ]}
        />
        <TextArea
          id={ids.dbsReason}
          name="dbsReason"
          label={t("safeguarding.update.dbsReason")}
          rows={2}
          maxLength={MEASURES_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "dbsReason")}
        />
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className={legend}>{t("safeguarding.form.measures")}</legend>
        <Checkbox
          name="measuresChanged"
          value="yes"
          label={t("safeguarding.update.measuresChanged")}
        />
        <TextArea
          id={ids.protectiveMeasures}
          name="protectiveMeasures"
          label={t("safeguarding.form.measures")}
          hint={t("safeguarding.form.measuresHint")}
          rows={3}
          maxLength={MEASURES_MAX}
          defaultValue={protectiveMeasures ?? ""}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "protectiveMeasures")}
        />
      </fieldset>
      <RadioGroup
        id={ids.measuresOutcome}
        name="measuresOutcome"
        legend={t("safeguarding.update.measuresOutcome")}
        hint={t("safeguarding.update.measuresOutcomeHint")}
        options={MEASURES_OUTCOMES.map((value) => ({
          value,
          label: t("safeguarding.measuresOutcome", { outcome: value }),
        }))}
        {...(measuresOutcome ? { defaultValue: measuresOutcome } : {})}
        error={errorFor(result, "measuresOutcome")}
      />
      <div>
        <Button type="submit" icon={<Save {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("safeguarding.update.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("safeguarding.update.done")} fieldIds={ids} />
    </form>
  );
}

/** One step on the concern, with a reason where it needs one; what it still needs is listed. */
export function ConcernStepForm({
  id,
  version,
  to,
  needs,
}: {
  readonly id: string;
  readonly version: number;
  readonly to: SafeguardingState;
  readonly needs: readonly string[];
}) {
  const ids = useFieldIds(["reason"]);
  const { submit, result, pending } = useSubmit(
    (form) => readSafeguardingStep(form, t, { to, version }),
    (body) => stepSafeguardingConcern(id, body),
    undefined,
    t("safeguarding.step.done"),
  );
  const withReason = to === "no_referral" || to === "closed";
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      {to === "closed" ? <p className="m-0">{t("safeguarding.step.closeFinal")}</p> : null}
      {needs.length > 0 ? <p className="m-0">{t("safeguarding.step.needsIntro")}</p> : null}
      {needs.length > 0 ? (
        <ul className="m-0 flex flex-col gap-1 pl-5">
          {needs.map((need) => (
            <li key={need}>{need}</li>
          ))}
        </ul>
      ) : null}
      {withReason ? (
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("safeguarding.step.reason")}
          rows={2}
          maxLength={MEASURES_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "reason")}
        />
      ) : null}
      {needs.length === 0 ? (
        <div>
          <Button type="submit" variant="secondary" icon={<Send {...icon} />} disabled={pending}>
            {pending ? t("common.saving") : t("safeguarding.step.submit", { to })}
          </Button>
        </div>
      ) : null}
      <FormFeedback result={result} success={t("safeguarding.step.done")} fieldIds={ids} />
    </form>
  );
}
