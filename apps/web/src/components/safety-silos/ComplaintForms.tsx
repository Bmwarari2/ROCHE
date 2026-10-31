"use client";

import type { ComplaintState } from "@harbour/contracts";
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
import { MessageSquarePlus, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { recordComplaint, recordCompliment, stepComplaint } from "@/app/actions/safety-silos";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import {
  COMPLAINT_CHANNELS,
  COMPLAINT_OUTCOMES,
  COMPLAINT_RELATIONSHIPS,
  COMPLAINT_SUMMARY_MAX,
  COMPLAINT_TEXT_MAX,
  readComplaint,
  readComplaintStep,
  readCompliment,
} from "@/lib/complaints";
import { uuidv7 } from "@/lib/entry-id";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, partsFor } from "@/lib/outcome";
import { boxesOf, dateBoxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";
import { useSubmit } from "./use-submit";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
type Place = { readonly id: string; readonly name: string };

function LocationField({
  id,
  locations,
  locationId,
  error,
}: {
  readonly id: string;
  readonly locations: readonly Place[];
  readonly locationId: string | null;
  readonly error?: string | undefined;
}) {
  return (
    <SelectField
      id={id}
      name="locationId"
      label={t("complaints.form.location")}
      defaultValue={locationId ?? locations[0]?.id ?? ""}
      options={locations.map((l) => ({ value: l.id, label: l.name }))}
      {...(error ? { error } : {})}
    />
  );
}

/** Recording a complaint as it arrived: who, how, when, when they knew, and what it is about. */
export function NewComplaintForm({
  locations,
  locationId,
}: {
  readonly locations: readonly Place[];
  readonly locationId: string | null;
}) {
  const router = useRouter();
  const ids = useFieldIds([
    "locationId",
    "complainantName",
    "complainantRelationship",
    "complainantContact",
    "channel",
    "receivedAt",
    "knewOfMatterOn",
    "summary",
  ]);
  const { submit, result, pending } = useSubmit(
    (form) =>
      readComplaint(form, t, {
        id: uuidv7(),
        locationId: String(form.get("locationId") ?? ""),
      }),
    recordComplaint,
    (data) => {
      const created = data as { id?: string };
      if (created.id) router.push(`/complaints/${created.id}`);
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <LocationField
        id={ids.locationId}
        locations={locations}
        locationId={locationId}
        error={errorFor(result, "locationId")}
      />
      <TextField
        id={ids.complainantName}
        name="complainantName"
        label={t("complaints.form.name")}
        autoComplete="off"
        required
        error={errorFor(result, "complainantName")}
      />
      <RadioGroup
        id={ids.complainantRelationship}
        name="complainantRelationship"
        legend={t("complaints.form.relationship")}
        options={COMPLAINT_RELATIONSHIPS.map((value) => ({
          value,
          label: t("complaints.relationship", { value }),
        }))}
        error={errorFor(result, "complainantRelationship")}
      />
      <TextField
        id={ids.complainantContact}
        name="complainantContact"
        label={t("complaints.form.contact")}
        hint={t("complaints.form.contactHint")}
        autoComplete="off"
        error={errorFor(result, "complainantContact")}
      />
      <RadioGroup
        id={ids.channel}
        name="channel"
        legend={t("complaints.form.channel")}
        options={COMPLAINT_CHANNELS.map((value) => ({
          value,
          label: t("complaints.channel", { value }),
        }))}
        error={errorFor(result, "channel")}
      />
      <DateTimeInput
        id={ids.receivedAt}
        name="receivedAt"
        legend={t("complaints.form.received")}
        hint={t("care.when.hint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "receivedAt")}
        errorParts={boxesOf(partsFor(result, "receivedAt"))}
      />
      <DateInput
        id={ids.knewOfMatterOn}
        name="knewOfMatterOn"
        legend={t("complaints.form.knew")}
        hint={t("complaints.form.knewHint")}
        labels={dateTimeLabels(t)}
        error={errorFor(result, "knewOfMatterOn")}
        errorParts={dateBoxesOf(partsFor(result, "knewOfMatterOn"))}
      />
      <TextArea
        id={ids.summary}
        name="summary"
        label={t("complaints.form.summary")}
        rows={5}
        maxLength={COMPLAINT_SUMMARY_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "summary")}
      />
      <div>
        <Button type="submit" icon={<MessageSquarePlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("complaints.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("complaints.form.done")} fieldIds={ids} />
    </form>
  );
}

/**
 * One step on a complaint. A response asks for the outcome, what was done, the Ombudsman
 * signposted and the kept copy; an appeal for when it came and why; closing for a reason.
 */
export function ComplaintStepForm({
  id,
  version,
  to,
  documents,
}: {
  readonly id: string;
  readonly version: number;
  readonly to: Exclude<ComplaintState, "received">;
  readonly documents: readonly { readonly id: string; readonly title: string }[];
}) {
  const ids = useFieldIds([
    "outcome",
    "actionsTaken",
    "ombudsmanSignposted",
    "documentId",
    "appealReceivedAt",
    "appealReason",
    "reason",
  ]);
  const { submit, result, pending } = useSubmit(
    (form) => readComplaintStep(form, t, { to, version }),
    (body) => stepComplaint(id, body),
  );
  const responding = to === "responded" || to === "appeal_responded";
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {responding ? (
        <>
          <RadioGroup
            id={ids.outcome}
            name="outcome"
            legend={t("complaints.step.outcome")}
            options={COMPLAINT_OUTCOMES.map((value) => ({
              value,
              label: t("complaints.outcome", { value }),
            }))}
            error={errorFor(result, "outcome")}
          />
          <TextArea
            id={ids.actionsTaken}
            name="actionsTaken"
            label={t("complaints.step.actions")}
            rows={4}
            maxLength={COMPLAINT_TEXT_MAX}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, "actionsTaken")}
          />
          <Checkbox
            id={ids.ombudsmanSignposted}
            name="ombudsmanSignposted"
            value="yes"
            label={t("complaints.step.ombudsman")}
            error={errorFor(result, "ombudsmanSignposted")}
          />
          <SelectField
            id={ids.documentId}
            name="documentId"
            label={t("complaints.step.document")}
            hint={t("complaints.step.documentHint")}
            defaultValue=""
            options={[
              { value: "", label: t("complaints.step.documentNone") },
              ...documents.map((d) => ({ value: d.id, label: d.title })),
            ]}
            error={errorFor(result, "documentId")}
          />
        </>
      ) : null}
      {to === "appealed" ? (
        <>
          <DateTimeInput
            id={ids.appealReceivedAt}
            name="appealReceivedAt"
            legend={t("complaints.step.appealReceived")}
            hint={t("care.when.hint")}
            labels={dateTimeLabels(t)}
            repeated={ukRepeatedTime}
            error={errorFor(result, "appealReceivedAt")}
            errorParts={boxesOf(partsFor(result, "appealReceivedAt"))}
          />
          <TextArea
            id={ids.appealReason}
            name="appealReason"
            label={t("complaints.step.appealReason")}
            rows={3}
            maxLength={COMPLAINT_TEXT_MAX}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(result, "appealReason")}
          />
        </>
      ) : null}
      {to === "closed" ? (
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("complaints.step.reason")}
          rows={3}
          maxLength={COMPLAINT_TEXT_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "reason")}
        />
      ) : null}
      <div>
        <Button
          type="submit"
          variant={to === "closed" ? "secondary" : "primary"}
          icon={<Send {...icon} />}
          disabled={pending}
        >
          {pending ? t("common.saving") : t("complaints.step.submit", { to })}
        </Button>
      </div>
      <FormFeedback result={result} success={t("complaints.step.done")} fieldIds={ids} />
    </form>
  );
}

/** Recording a compliment: who it is from, when it came and what it says. Never a clock. */
export function NewComplimentForm({
  locations,
  locationId,
}: {
  readonly locations: readonly Place[];
  readonly locationId: string | null;
}) {
  const ids = useFieldIds(["locationId", "fromName", "fromRelationship", "receivedAt", "summary"]);
  const { submit, result, pending } = useSubmit(
    (form) =>
      readCompliment(form, t, { id: uuidv7(), locationId: String(form.get("locationId") ?? "") }),
    recordCompliment,
    (_data, form) => form.reset(),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <LocationField
        id={ids.locationId}
        locations={locations}
        locationId={locationId}
        error={errorFor(result, "locationId")}
      />
      <TextField
        id={ids.fromName}
        name="fromName"
        label={t("complaints.compliment.from")}
        autoComplete="off"
        error={errorFor(result, "fromName")}
      />
      <RadioGroup
        id={ids.fromRelationship}
        name="fromRelationship"
        legend={t("complaints.form.relationship")}
        options={COMPLAINT_RELATIONSHIPS.map((value) => ({
          value,
          label: t("complaints.relationship", { value }),
        }))}
        error={errorFor(result, "fromRelationship")}
      />
      <DateTimeInput
        id={ids.receivedAt}
        name="receivedAt"
        legend={t("complaints.form.received")}
        hint={t("care.when.hint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "receivedAt")}
        errorParts={boxesOf(partsFor(result, "receivedAt"))}
      />
      <TextArea
        id={ids.summary}
        name="summary"
        label={t("complaints.compliment.summary")}
        rows={4}
        maxLength={COMPLAINT_SUMMARY_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "summary")}
      />
      <div>
        <Button type="submit" icon={<MessageSquarePlus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("complaints.compliment.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("complaints.compliment.done")} fieldIds={ids} />
    </form>
  );
}
