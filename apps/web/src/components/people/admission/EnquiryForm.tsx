"use client";

import { Button, SelectField, TextField } from "@harbour/ui";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { recordEnquiry } from "@/app/actions/admission";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useEntryId, useFieldIds } from "@/components/care/form-state";
import { WhenField } from "@/components/care/WhenField";
import { startsNewEnquiry } from "@/lib/admission";
import { t } from "@/lib/i18n";
import { collectedRefusal, errorFor, type FieldProblem, partsFor } from "@/lib/outcome";
import { readDateField, readWhen } from "@/lib/uk-time";
import { useActionForm } from "./action-form";
import { DateField } from "./DateField";

const FIELDS = [
  "locationId",
  "givenName",
  "familyName",
  "preferredName",
  "dateOfBirth",
  "receivedAt",
] as const;

/**
 * Record an enquiry (people.md rule 1): who it is about and the home they asked about. Names and
 * a date of birth only; everything else is asked in the pre-admission assessment. The form's own
 * id goes with every attempt, so sending again never makes a second record (HZ-029). On success
 * the new record opens on its pre-admission tab.
 */
export function EnquiryForm({
  locations,
  defaultLocationId,
}: {
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly defaultLocationId: string | null;
}) {
  const router = useRouter();
  const form = useActionForm();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();
  const only = locations.length === 1 ? locations[0] : undefined;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const locationId = String(data.get("locationId") ?? "");
    if (!locationId) {
      problems.push({ field: "locationId", message: t("people.enquiry.form.homeRequired") });
    }
    const givenName = String(data.get("givenName") ?? "").trim();
    if (!givenName) {
      problems.push({ field: "givenName", message: t("people.enquiry.form.givenRequired") });
    }
    const familyName = String(data.get("familyName") ?? "").trim();
    if (!familyName) {
      problems.push({ field: "familyName", message: t("people.enquiry.form.familyRequired") });
    }
    const dob = readDateField(data, "dateOfBirth", {
      subject: t("people.enquiry.form.dobSubject"),
      t,
    });
    if (!dob.ok) problems.push({ field: "dateOfBirth", message: dob.message, parts: dob.parts });
    const when = readWhen(data, "receivedAt", t, {
      subject: t("people.enquiry.form.receivedSubject"),
    });
    if (!when.ok) problems.push({ field: "receivedAt", message: when.message, parts: when.parts });
    const refusal = collectedRefusal(problems);
    if (refusal || !dob.ok || !when.ok) {
      form.setResult(refusal);
      return;
    }
    const earlier = data.get("receivedAt-mode") === "earlier";
    form.run(
      () =>
        recordEnquiry({
          id: entry.id,
          locationId,
          givenName,
          familyName,
          preferredName: String(data.get("preferredName") ?? ""),
          dateOfBirth: dob.date ?? "",
          ...(earlier ? { receivedAt: when.instant } : {}),
        }),
      (person) => router.push(`/people/${person.id}/pre-admission?done=enquiry`),
      // The id went with other details already: the next attempt is a new enquiry (HZ-001).
      (outcome) => {
        if (startsNewEnquiry(outcome)) entry.next();
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {only ? (
          <input type="hidden" name="locationId" value={only.id} />
        ) : (
          <SelectField
            id={ids.locationId}
            name="locationId"
            label={t("people.enquiry.form.home")}
            emptyOption={t("people.enquiry.form.homeChoose")}
            defaultValue={defaultLocationId ?? ""}
            required
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            error={errorFor(form.result, "locationId")}
            className="max-w-md"
          />
        )}
        <TextField
          id={ids.givenName}
          name="givenName"
          label={t("people.enquiry.form.givenName")}
          autoComplete="off"
          maxLength={100}
          required
          error={errorFor(form.result, "givenName")}
          className="max-w-md"
        />
        <TextField
          id={ids.familyName}
          name="familyName"
          label={t("people.enquiry.form.familyName")}
          autoComplete="off"
          maxLength={100}
          required
          error={errorFor(form.result, "familyName")}
          className="max-w-md"
        />
        <TextField
          id={ids.preferredName}
          name="preferredName"
          label={t("people.enquiry.form.preferredName")}
          hint={t("people.enquiry.form.preferredHint")}
          autoComplete="off"
          maxLength={100}
          className="max-w-md"
        />
        <DateField
          id={ids.dateOfBirth}
          name="dateOfBirth"
          legend={t("people.enquiry.form.dateOfBirth")}
          result={form.result}
        />
        <WhenField
          name="receivedAt"
          id={ids.receivedAt}
          legend={t("people.enquiry.form.received")}
          error={errorFor(form.result, "receivedAt")}
          errorParts={partsFor(form.result, "receivedAt")}
        />
        <div>
          <Button type="submit" disabled={form.pending}>
            {form.pending ? t("common.saving") : t("people.enquiry.form.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={form.result} success={t("people.enquiry.form.saved")} fieldIds={ids} />
    </div>
  );
}
