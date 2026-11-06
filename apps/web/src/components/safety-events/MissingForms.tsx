"use client";

import { Button, DateTimeInput, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { CircleCheck, Plus, Siren } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { addMissingEvent, closeMissingEpisode, openMissingEpisode } from "@/app/actions/missing";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { uuidv7 } from "@/lib/entry-id";
import { characterCount, t } from "@/lib/i18n";
import { readOpenEpisode, readTimelineEntry, type TimelineKind } from "@/lib/missing";
import { errorFor, partsFor } from "@/lib/outcome";
import { boxesOf, dateTimeLabels, ukRepeatedTime } from "@/lib/uk-time";
import { useSubmit } from "./use-submit";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Opening a missing person episode from its incident: when they were noticed missing, when last
 * seen, and whether the organisation's risk assessment says call the police at once. The police
 * call target starts from when they were noticed missing.
 */
export function OpenEpisodeForm({
  incidentId,
  personId,
}: {
  readonly incidentId: string;
  readonly personId: string;
}) {
  const router = useRouter();
  const ids = useFieldIds(["noticedMissingAt", "lastSeenAt", "immediateRisk"]);
  // One id per form: a retry after an unknown outcome opens the same episode, never a second.
  const [episodeId] = useState(() => uuidv7());
  const { submit, result, pending } = useSubmit(
    (form) => readOpenEpisode(form, t, { id: episodeId, incidentId, personId }),
    openMissingEpisode,
    (data) => {
      const opened = data as { id?: string };
      router.push(`/missing/${opened.id ?? episodeId}`);
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <DateTimeInput
        id={ids.noticedMissingAt}
        name="noticedMissingAt"
        legend={t("missing.form.noticed")}
        hint={t("missing.form.noticedHint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "noticedMissingAt")}
        errorParts={boxesOf(partsFor(result, "noticedMissingAt"))}
      />
      <DateTimeInput
        id={ids.lastSeenAt}
        name="lastSeenAt"
        legend={t("missing.form.lastSeen")}
        hint={t("missing.form.lastSeenHint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "lastSeenAt")}
        errorParts={boxesOf(partsFor(result, "lastSeenAt"))}
      />
      <RadioGroup
        id={ids.immediateRisk}
        name="immediateRisk"
        legend={t("missing.form.risk")}
        options={[
          { value: "yes", label: t("missing.form.riskYes") },
          { value: "no", label: t("missing.form.riskNo") },
        ]}
        error={errorFor(result, "immediateRisk")}
      />
      <div>
        <Button type="submit" icon={<Siren {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("missing.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("missing.form.done")} fieldIds={ids} />
    </form>
  );
}

/** Adding to the timeline or search log; the police called need their reference. */
export function TimelineEntryForm({
  episodeId,
  kinds,
}: {
  readonly episodeId: string;
  readonly kinds: readonly TimelineKind[];
}) {
  const ids = useFieldIds(["kind", "at", "reference", "area", "note"]);
  // The entry's id lasts until it is saved, so a retry after an unknown outcome is a no-op.
  const [entryId, setEntryId] = useState(() => uuidv7());
  const { submit, result, pending } = useSubmit(
    (form) => readTimelineEntry(form, t, { id: entryId }),
    (body) => addMissingEvent(episodeId, body),
    (_data, form) => {
      form.reset();
      setEntryId(uuidv7());
    },
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <SelectField
        id={ids.kind}
        name="kind"
        label={t("missing.timeline.kind")}
        defaultValue=""
        options={[
          { value: "", label: t("missing.timeline.choose") },
          ...kinds.map((kind) => ({
            value: kind,
            label: t("missing.timeline.kindLabel", { kind }),
          })),
        ]}
        error={errorFor(result, "kind")}
      />
      <DateTimeInput
        id={ids.at}
        name="at"
        legend={t("missing.timeline.at")}
        hint={t("care.when.hint")}
        labels={dateTimeLabels(t)}
        repeated={ukRepeatedTime}
        error={errorFor(result, "at")}
        errorParts={boxesOf(partsFor(result, "at"))}
      />
      <TextField
        id={ids.reference}
        name="reference"
        label={t("missing.timeline.reference")}
        hint={t("missing.timeline.referenceHint")}
        autoComplete="off"
        error={errorFor(result, "reference")}
      />
      <TextField
        id={ids.area}
        name="area"
        label={t("missing.timeline.area")}
        hint={t("missing.timeline.areaHint")}
        autoComplete="off"
        error={errorFor(result, "area")}
      />
      <TextArea
        id={ids.note}
        name="note"
        label={t("missing.timeline.note")}
        rows={3}
        maxLength={4000}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "note")}
      />
      <div>
        <Button type="submit" icon={<Plus {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("missing.timeline.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("missing.timeline.done")} fieldIds={ids} />
    </form>
  );
}

/** Closing the episode, once the API says nothing is left (welfare check, debrief). */
export function CloseEpisodeForm({
  episodeId,
  version,
}: {
  readonly episodeId: string;
  readonly version: number;
}) {
  const { submit, result, pending } = useSubmit(
    () => ({ ok: true as const, body: { version } }),
    (body) => closeMissingEpisode(episodeId, body.version),
    undefined,
    t("missing.close.done"),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <p className="m-0">{t("missing.close.final")}</p>
      <div>
        <Button
          type="submit"
          variant="secondary"
          icon={<CircleCheck {...icon} />}
          disabled={pending}
        >
          {pending ? t("common.saving") : t("missing.close.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("missing.close.done")} />
    </form>
  );
}
