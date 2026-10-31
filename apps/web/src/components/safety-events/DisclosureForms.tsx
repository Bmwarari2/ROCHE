"use client";

import {
  Button,
  Checkbox,
  DateInput,
  DateTimeInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { CircleAlert, FileSearch, FileText, Gavel, Send, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  collectDisclosure,
  decideDisclosure,
  decideDisclosureItem,
  logDisclosureRequest,
  prepareDisclosure,
  recordPreventionReport,
  releaseDisclosure,
  withdrawDisclosure,
} from "@/app/actions/disclosures";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import {
  DISCLOSURE_TEXT_MAX,
  DISCLOSURE_TYPES,
  ITEM_DECISIONS,
  readDecide,
  readItemDecision,
  readLogRequest,
  readPreventionReport,
  readWithdraw,
} from "@/lib/disclosures";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import { boxesOf, dateBoxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";
import { useSubmit } from "./use-submit";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Logging a request as it arrived: about whom, what kind (its legal basis follows), who asked. */
export function LogRequestForm({
  people,
  personId,
}: {
  readonly people: readonly { readonly id: string; readonly name: string }[];
  readonly personId: string | null;
}) {
  const router = useRouter();
  const ids = useFieldIds([
    "personId",
    "type",
    "requesterName",
    "requesterOrganisation",
    "requesterReference",
    "statedPurpose",
    "receivedAt",
  ]);
  const { submit, result, pending } = useSubmit(
    (form) => readLogRequest(form, t),
    logDisclosureRequest,
    (data) => router.push(`/disclosures/${data.id}`),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.personId}
        name="personId"
        label={t("disclosures.form.person")}
        defaultValue={personId ?? people[0]?.id ?? ""}
        options={people.map((p) => ({ value: p.id, label: p.name }))}
        error={errorFor(result, "personId")}
      />
      <RadioGroup
        id={ids.type}
        name="type"
        legend={t("disclosures.form.type")}
        hint={t("disclosures.form.typeHint")}
        options={DISCLOSURE_TYPES.map((value) => ({
          value,
          label: t("disclosures.type", { value }),
        }))}
        error={errorFor(result, "type")}
      />
      <TextField
        id={ids.requesterName}
        name="requesterName"
        label={t("disclosures.form.name")}
        autoComplete="off"
        error={errorFor(result, "requesterName")}
      />
      <TextField
        id={ids.requesterOrganisation}
        name="requesterOrganisation"
        label={t("disclosures.form.organisation")}
        autoComplete="off"
        error={errorFor(result, "requesterOrganisation")}
      />
      <TextField
        id={ids.requesterReference}
        name="requesterReference"
        label={t("disclosures.form.reference")}
        hint={t("disclosures.form.referenceHint")}
        autoComplete="off"
        error={errorFor(result, "requesterReference")}
      />
      <TextArea
        id={ids.statedPurpose}
        name="statedPurpose"
        label={t("disclosures.form.purpose")}
        hint={t("disclosures.form.purposeHint")}
        rows={3}
        maxLength={DISCLOSURE_TEXT_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "statedPurpose")}
      />
      <DateTimeInput
        id={ids.receivedAt}
        name="receivedAt"
        legend={t("disclosures.form.received")}
        hint={t("care.when.hint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "receivedAt")}
        errorParts={boxesOf(partsFor(result, "receivedAt"))}
      />
      <div>
        <Button type="submit" icon={<FileText {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("disclosures.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("disclosures.form.done")} fieldIds={ids} />
    </form>
  );
}

/** Finding the person's records across every module (the collector); can be run again. */
export function CollectForm({
  id,
  collected,
}: {
  readonly id: string;
  readonly collected: boolean;
}) {
  const { submit, result, pending } = useSubmit(
    () => ({ ok: true as const, body: null }),
    () => collectDisclosure(id),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <div>
        <Button
          type="submit"
          variant={collected ? "secondary" : "primary"}
          icon={<FileSearch {...icon} />}
          disabled={pending}
        >
          {pending
            ? t("disclosures.pending.collecting")
            : t(collected ? "disclosures.collect.again" : "disclosures.collect.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("disclosures.collect.done")} />
    </form>
  );
}

/** One versioned step with no fields: prepare for approval, or release the pack. */
export function VersionedStepForm({
  id,
  version,
  step,
}: {
  readonly id: string;
  readonly version: number;
  readonly step: "prepare" | "release";
}) {
  const { submit, result, pending } = useSubmit(
    () => ({ ok: true as const, body: { expectedVersion: version } }),
    (body) => (step === "prepare" ? prepareDisclosure(id, body) : releaseDisclosure(id, body)),
    undefined,
    t("disclosures.step.done", { step }),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <p className="m-0">{t("disclosures.step.explain", { step })}</p>
      <div>
        <Button type="submit" icon={<Send {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("disclosures.step.submit", { step })}
        </Button>
      </div>
      <FormFeedback result={result} success={t("disclosures.step.done", { step })} />
    </form>
  );
}

/** The approver's decision; the API refuses anyone who prepared the request. */
export function DecideForm({ id, version }: { readonly id: string; readonly version: number }) {
  const ids = useFieldIds(["decision", "reason"]);
  const { submit, result, pending } = useSubmit(
    (form) => readDecide(form, t, { expectedVersion: version }),
    (body) => decideDisclosure(id, body),
    undefined,
    t("disclosures.decide.done"),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.decision}
        name="decision"
        legend={t("disclosures.decide.legend")}
        options={(["approve", "refuse"] as const).map((value) => ({
          value,
          label: t("disclosures.decide.option", { value }),
        }))}
        error={errorFor(result, "decision")}
      />
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("disclosures.decide.reason")}
        hint={t("disclosures.decide.reasonHint")}
        rows={3}
        maxLength={DISCLOSURE_TEXT_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button type="submit" icon={<Gavel {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("disclosures.decide.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("disclosures.decide.done")} fieldIds={ids} />
    </form>
  );
}

/** Withdrawing a request before it is released, with the reason. */
export function WithdrawForm({ id, version }: { readonly id: string; readonly version: number }) {
  const ids = useFieldIds(["reason"]);
  const { submit, result, pending } = useSubmit(
    (form) => readWithdraw(form, t, { expectedVersion: version }),
    (body) => withdrawDisclosure(id, body),
    undefined,
    t("disclosures.withdraw.done"),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <p className="m-0">{t("disclosures.withdraw.final")}</p>
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("disclosures.withdraw.reason")}
        rows={2}
        maxLength={DISCLOSURE_TEXT_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<Undo2 {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("disclosures.withdraw.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("disclosures.withdraw.done")} fieldIds={ids} />
    </form>
  );
}

/** A coroner's Regulation 28 report, and when the response was sent. */
export function PreventionReportForm({
  id,
  version,
}: {
  readonly id: string;
  readonly version: number;
}) {
  const ids = useFieldIds(["reportOn", "respondedOn"]);
  const { submit, result, pending } = useSubmit(
    (form) => readPreventionReport(form, t, { expectedVersion: version }),
    (body) => recordPreventionReport(id, body),
  );
  const labels = dateTimeLabels(t);
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateInput
        id={ids.reportOn}
        name="reportOn"
        legend={t("disclosures.prevention.reportOn")}
        hint={t("care.date.hint")}
        labels={labels}
        error={errorFor(result, "reportOn")}
        errorParts={dateBoxesOf(partsFor(result, "reportOn"))}
      />
      <DateInput
        id={ids.respondedOn}
        name="respondedOn"
        legend={t("disclosures.prevention.respondedOn")}
        hint={t("disclosures.prevention.respondedHint")}
        labels={labels}
        error={errorFor(result, "respondedOn")}
        errorParts={dateBoxesOf(partsFor(result, "respondedOn"))}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<Send {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("disclosures.prevention.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("disclosures.prevention.done")} fieldIds={ids} />
    </form>
  );
}

/**
 * The decision on one collected record: disclose it, redact named fields, or withhold it with a
 * reason. The hash of the record as shown goes with it, so a record that changed is refused.
 */
export function ItemDecisionForm({
  id,
  itemId,
  fields,
  contentSha256,
  version,
  redacted,
}: {
  readonly id: string;
  readonly itemId: string;
  readonly fields: readonly string[];
  readonly contentSha256: string;
  readonly version: number;
  readonly redacted: readonly string[];
}) {
  const router = useRouter();
  const ids = useFieldIds(["decision", "redactedFields", "reason"]);
  const { submit, result, pending } = useSubmit(
    (form) => readItemDecision(form, t, { contentSha256, expectedVersion: version }),
    (body) => decideDisclosureItem(id, itemId, body),
    () => router.push(`/disclosures/${id}`),
  );
  const fieldsError = errorFor(result, "redactedFields");
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.decision}
        name="decision"
        legend={t("disclosures.item.legend")}
        options={ITEM_DECISIONS.map((decision) => ({
          value: decision,
          label: t("disclosures.item.decision", { decision }),
          description: t("disclosures.item.decisionHint", { decision }),
        }))}
        error={errorFor(result, "decision")}
      />
      <fieldset
        className="m-0 flex flex-col gap-1 border-0 p-0"
        aria-describedby={[
          `${ids.redactedFields}-hint`,
          fieldsError ? `${ids.redactedFields}-error` : null,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <legend className="mb-2 text-body font-semibold">{t("disclosures.item.fields")}</legend>
        <p
          id={`${ids.redactedFields}-hint`}
          className="m-0 mb-2 text-body-dense text-text-secondary"
        >
          {t("disclosures.item.fieldsHint")}
        </p>
        {fieldsError ? (
          <p
            id={`${ids.redactedFields}-error`}
            className="m-0 flex items-center gap-2 text-body-dense font-semibold text-danger"
          >
            <CircleAlert {...icon} />
            {fieldsError}
          </p>
        ) : null}
        {fields.map((field, index) => (
          <Checkbox
            key={field}
            {...(index === 0 ? { id: ids.redactedFields } : {})}
            name="redactedFields"
            value={field}
            label={field}
            defaultChecked={redacted.includes(field)}
            {...(fieldsError ? { "aria-invalid": true } : {})}
          />
        ))}
      </fieldset>
      <TextArea
        id={ids.reason}
        name="reason"
        label={t("disclosures.item.reason")}
        hint={t("disclosures.item.reasonHint")}
        rows={2}
        maxLength={DISCLOSURE_TEXT_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "reason")}
      />
      <div>
        <Button type="submit" icon={<Send {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("disclosures.item.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("disclosures.item.done")} fieldIds={ids} />
    </form>
  );
}
