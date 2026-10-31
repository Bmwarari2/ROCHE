"use client";

import { Button, Checkbox, RadioGroup, SelectField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { admitPerson } from "@/app/actions/admission";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { WhenField } from "@/components/care/WhenField";
import { type BedChoiceGroup, readBedChoice } from "@/lib/admission";
import { t } from "@/lib/i18n";
import { collectedRefusal, errorFor, type FieldProblem, partsFor } from "@/lib/outcome";
import { readDateField, readWhen } from "@/lib/uk-time";
import { useActionForm } from "./action-form";
import { DateField } from "./DateField";
import { PLACEMENT_TYPES } from "./EnquiryStatusForms";

type PlacementType = (typeof PLACEMENT_TYPES)[number];

const FIELDS = [
  "serviceId",
  "placementType",
  "startDate",
  "trialEndsOn",
  "bed",
  "funding",
  "admittedAt",
] as const;

/** The labels of a bed select: "Room 12", or "Room 12, bed 2" in a shared room. */
export function bedSelectGroups(groups: readonly BedChoiceGroup[]) {
  return groups.map((group) => ({
    label: group.unit ?? t("people.room.noUnit"),
    options: group.beds.map((bed) => ({
      value: bed.value,
      label: bed.shared
        ? t("people.room.roomAndBed", { room: bed.roomLabel, bed: bed.bed })
        : t("people.room.roomOnly", { room: bed.roomLabel }),
    })),
  }));
}

/**
 * Record the admission (people.md rules 5 and 6; people.admission.manage): the service and kind
 * of placement, the first day, the trial's end for a trial, funding, and for residential and
 * nursing placements a free bed. The API checks the decision and its conditions again
 * (checkAdmissionReadiness), the bed on that day (planBedMove), and the person's version; the
 * header's room then comes from the bed history (HZ-001).
 */
export function AdmitForm({
  personId,
  version,
  services,
  defaultServiceId,
  defaultType,
  defaultTrialEndsOn,
  beds,
  today,
}: {
  readonly personId: string;
  readonly version: number;
  readonly services: readonly { readonly id: string; readonly name: string }[];
  readonly defaultServiceId: string | null;
  readonly defaultType: PlacementType | null;
  readonly defaultTrialEndsOn: string | null;
  readonly beds: readonly BedChoiceGroup[];
  readonly today: string;
}) {
  const router = useRouter();
  const form = useActionForm();
  const ids = useFieldIds(FIELDS);
  const [type, setType] = useState<PlacementType | null>(defaultType);
  const needsBed = type !== "package";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const serviceId = String(data.get("serviceId") ?? "");
    if (!serviceId) {
      problems.push({ field: "serviceId", message: t("people.admission.form.serviceRequired") });
    }
    if (!type) {
      problems.push({ field: "placementType", message: t("people.admission.form.typeRequired") });
    }
    const start = readDateField(data, "startDate", {
      subject: t("people.admission.form.startSubject"),
      t,
    });
    if (!start.ok)
      problems.push({ field: "startDate", message: start.message, parts: start.parts });
    const trial = readDateField(data, "trialEndsOn", {
      subject: t("people.admission.form.trialSubject"),
      optional: type !== "trial",
      t,
    });
    if (!trial.ok)
      problems.push({ field: "trialEndsOn", message: trial.message, parts: trial.parts });
    const bed = readBedChoice(data.get("bed"));
    if (needsBed && !bed) {
      problems.push({ field: "bed", message: t("people.admission.form.bedRequired") });
    }
    const when = readWhen(data, "admittedAt", t, {
      subject: t("people.admission.form.arrivedSubject"),
    });
    if (!when.ok) problems.push({ field: "admittedAt", message: when.message, parts: when.parts });
    const refusal = collectedRefusal(problems);
    if (refusal || !type || !start.ok || !trial.ok || !when.ok) {
      form.setResult(refusal);
      return;
    }
    form.run(
      () =>
        admitPerson(personId, {
          serviceId,
          placementType: type,
          startDate: start.date ?? "",
          ...(type === "trial" && trial.date ? { trialEndsOn: trial.date } : {}),
          localAuthorityFunded: data.get("localAuthorityFunded") === "on",
          nhsFunded: data.get("nhsFunded") === "on",
          ...(needsBed && bed ? { roomId: bed.roomId } : {}),
          bed: bed?.bed ?? 1,
          admittedAt: when.instant,
          version,
        }),
      () => router.push(`/people/${personId}/admission?done=admitted`, { scroll: false }),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <SelectField
          id={ids.serviceId}
          name="serviceId"
          label={t("people.admission.form.service")}
          emptyOption={t("people.preAdmission.start.serviceChoose")}
          defaultValue={defaultServiceId ?? ""}
          required
          options={services.map((s) => ({ value: s.id, label: s.name }))}
          error={errorFor(form.result, "serviceId")}
          className="max-w-md"
        />
        <RadioGroup<PlacementType>
          id={ids.placementType}
          name="placementType"
          legend={t("people.admission.form.type")}
          layout="inline"
          value={type}
          onValueChange={setType}
          required
          error={errorFor(form.result, "placementType")}
          options={PLACEMENT_TYPES.map((value) => ({
            value,
            label: t("people.placementType", { type: value }),
          }))}
        />
        <DateField
          id={ids.startDate}
          name="startDate"
          legend={t("people.admission.form.start")}
          result={form.result}
          defaultValue={today}
        />
        {type === "trial" ? (
          <DateField
            id={ids.trialEndsOn}
            name="trialEndsOn"
            legend={t("people.admission.form.trialEnds")}
            result={form.result}
            defaultValue={defaultTrialEndsOn}
          />
        ) : null}
        {needsBed ? (
          beds.length > 0 ? (
            <SelectField
              id={ids.bed}
              name="bed"
              label={t("people.admission.form.bed")}
              hint={t("people.admission.form.bedHint")}
              emptyOption={t("people.room.choose")}
              required
              groups={bedSelectGroups(beds)}
              error={errorFor(form.result, "bed")}
              className="max-w-md"
            />
          ) : (
            <p id={ids.bed} tabIndex={-1} className="m-0 font-semibold">
              {t("people.room.noneFree")}
            </p>
          )
        ) : null}
        <fieldset id={ids.funding} className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="font-semibold">{t("people.admission.form.funding")}</legend>
          <Checkbox name="localAuthorityFunded" label={t("people.admission.form.councilFunded")} />
          <Checkbox name="nhsFunded" label={t("people.admission.form.nhsFunded")} />
        </fieldset>
        <WhenField
          name="admittedAt"
          id={ids.admittedAt}
          legend={t("people.admission.form.arrived")}
          error={errorFor(form.result, "admittedAt")}
          errorParts={partsFor(form.result, "admittedAt")}
        />
        <div>
          <Button type="submit" disabled={form.pending}>
            {form.pending ? t("common.saving") : t("people.admission.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback
        result={form.result}
        success={t("people.admission.form.saved")}
        fieldIds={ids}
      />
    </div>
  );
}
