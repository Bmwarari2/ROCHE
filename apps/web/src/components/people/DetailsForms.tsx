"use client";

import type { ContactOut, PersonDetails } from "@harbour/contracts";
import {
  Button,
  Checkbox,
  DateInput,
  RadioGroup,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { type FormEvent, useState } from "react";
import { addContact, updateContact, updatePersonDetails } from "@/app/actions/person-details";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { collectedRefusal, errorFor, type FieldProblem, partsFor } from "@/lib/outcome";
import {
  CONTACT_FIELDS,
  CONTACT_ROLES,
  contactChanges,
  contactName,
  DETAILS_FIELDS,
  ETHNIC_CATEGORY_CODES,
  isAuthorityRole,
  LANGUAGE_CODES,
  readContactForm,
  readDetailsForm,
  SEX_CODES,
} from "@/lib/person-details";
import { dateBoxesOf, readDateField, ukToday } from "@/lib/uk-time";
import { InlineSection, useRecordSend } from "./RecordForms";

/**
 * The personal details tab's forms (PEOP-001): change the demographics, record the national data
 * opt-out, and add or change a contact or representative. Each sends only what changed, with the
 * version it was opened at; the API checks every rule again.
 */

const dateLabels = () => ({
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
});

/** A select's options from codes, with "Not recorded" first and a stored code not listed kept. */
function codeOptions(
  codes: readonly string[],
  key: "people.details.sex" | "people.details.ethnicCategory" | "people.details.language",
  current: string | null,
) {
  const all = current && !codes.includes(current) ? [...codes, current] : codes;
  return all.map((code) => ({ value: code, label: t(key, { code }) }));
}

export function DetailsForm({
  personId,
  path,
  details,
}: {
  readonly personId: string;
  readonly path: string;
  readonly details: PersonDetails;
}) {
  const ids = useFieldIds(DETAILS_FIELDS);
  const { result, setResult, pending, send } = useRecordSend(path);
  const field = (name: (typeof DETAILS_FIELDS)[number]) => ({
    id: ids[name],
    name,
    label: t("people.details.field", { field: name }),
    error: errorFor(result, name),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const dob = readDateField(form, "dateOfBirth", {
      subject: t("people.details.form.dateOfBirth"),
      optional: true,
      t,
    });
    if (!dob.ok) problems.push({ field: "dateOfBirth", message: dob.message, parts: dob.parts });
    const read = readDetailsForm(
      form,
      details,
      dob.ok ? dob.date : details.dateOfBirth,
      ukToday(),
      t,
    );
    if (!read.ok) {
      for (const [name, message] of Object.entries(read.errors)) {
        problems.push({ field: name, message });
      }
    }
    // Every problem at once, in the order of the form (WCAG 3.3.1).
    problems.sort(
      (a, b) => DETAILS_FIELDS.indexOf(a.field as never) - DETAILS_FIELDS.indexOf(b.field as never),
    );
    const refusal = collectedRefusal(problems);
    if (refusal) {
      setResult(refusal);
      return;
    }
    if (read.ok) {
      send("details", () => updatePersonDetails(personId, read.changes, details.version));
    }
  };

  return (
    <InlineSection open={t("people.details.change")}>
      {(close) => (
        <>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <h4 className="m-0 text-body font-semibold">{t("people.details.form.title")}</h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                {...field("title")}
                defaultValue={details.title ?? ""}
                maxLength={40}
                autoComplete="off"
                className="max-w-xs"
              />
              <TextField
                {...field("preferredName")}
                defaultValue={details.preferredName ?? ""}
                hint={t("people.details.form.preferredHint")}
                maxLength={100}
                autoComplete="off"
              />
              <TextField
                {...field("givenName")}
                defaultValue={details.givenName}
                maxLength={100}
                required
                autoComplete="off"
              />
              <TextField
                {...field("familyName")}
                defaultValue={details.familyName}
                maxLength={100}
                required
                autoComplete="off"
              />
            </div>
            <DateInput
              id={ids.dateOfBirth}
              name="dateOfBirth"
              legend={t("people.details.field", { field: "dateOfBirth" })}
              hint={t("care.date.hint")}
              defaultValue={details.dateOfBirth}
              error={errorFor(result, "dateOfBirth")}
              errorParts={dateBoxesOf(partsFor(result, "dateOfBirth"))}
              labels={dateLabels()}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                {...field("nhsNumber")}
                defaultValue={details.nhsNumber ?? ""}
                hint={t("people.details.form.nhsHint")}
                inputMode="numeric"
                maxLength={20}
                autoComplete="off"
              />
              <TextField
                {...field("localIdentifier")}
                defaultValue={details.localIdentifier ?? ""}
                hint={t("people.details.form.localHint")}
                maxLength={60}
                autoComplete="off"
              />
              <SelectField
                {...field("sexCode")}
                defaultValue={details.sexCode ?? ""}
                emptyOption={t("people.details.form.notRecorded")}
                options={codeOptions(SEX_CODES, "people.details.sex", details.sexCode)}
              />
              <SelectField
                {...field("genderIdentity")}
                defaultValue={details.genderIdentity ?? ""}
                emptyOption={t("people.details.form.notRecorded")}
                options={codeOptions(SEX_CODES, "people.details.sex", details.genderIdentity)}
              />
              <SelectField
                {...field("ethnicCategoryCode")}
                defaultValue={details.ethnicCategoryCode ?? ""}
                emptyOption={t("people.details.form.notRecorded")}
                options={codeOptions(
                  ETHNIC_CATEGORY_CODES,
                  "people.details.ethnicCategory",
                  details.ethnicCategoryCode,
                )}
              />
              <TextField
                {...field("religion")}
                defaultValue={details.religion ?? ""}
                maxLength={100}
                autoComplete="off"
              />
              <SelectField
                {...field("firstLanguage")}
                defaultValue={details.firstLanguage ?? ""}
                emptyOption={t("people.details.form.notRecorded")}
                options={codeOptions(
                  LANGUAGE_CODES,
                  "people.details.language",
                  details.firstLanguage,
                )}
              />
            </div>
            <Checkbox
              id={ids.interpreterRequired}
              name="interpreterRequired"
              value="yes"
              label={t("people.details.form.interpreter")}
              defaultChecked={details.interpreterRequired}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                {...field("addressLine1")}
                defaultValue={details.addressLine1 ?? ""}
                maxLength={200}
                autoComplete="off"
              />
              <TextField
                {...field("addressLine2")}
                defaultValue={details.addressLine2 ?? ""}
                maxLength={200}
                autoComplete="off"
              />
              <TextField
                {...field("town")}
                defaultValue={details.town ?? ""}
                maxLength={100}
                autoComplete="off"
              />
              <TextField
                {...field("postcode")}
                defaultValue={details.postcode ?? ""}
                maxLength={10}
                autoComplete="off"
                className="max-w-xs"
              />
              <TextField
                {...field("gpPracticeOdsCode")}
                defaultValue={details.gpPracticeOdsCode ?? ""}
                hint={t("people.details.form.odsHint")}
                maxLength={6}
                autoComplete="off"
                className="max-w-xs"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? t("common.saving") : t("people.details.form.submit")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setResult(null);
                  close();
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </form>
          <FormFeedback result={result} success={t("people.details.saved")} fieldIds={ids} />
        </>
      )}
    </InlineSection>
  );
}

/** Records that the person has opted out of the national data opt-out, or that they have not. */
export function OptOutForm({
  personId,
  path,
  optedOut,
  version,
}: {
  readonly personId: string;
  readonly path: string;
  readonly optedOut: boolean;
  readonly version: number;
}) {
  const { result, pending, send } = useRecordSend(path);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          disabled={pending}
          icon={
            optedOut ? (
              <ShieldCheck size={16} strokeWidth={1.5} />
            ) : (
              <ShieldOff size={16} strokeWidth={1.5} />
            )
          }
          onClick={() =>
            send(optedOut ? "optInRecorded" : "optOutRecorded", () =>
              updatePersonDetails(personId, { nationalDataOptOut: !optedOut }, version),
            )
          }
        >
          {pending
            ? t("common.saving")
            : optedOut
              ? t("people.optOut.remove")
              : t("people.optOut.record")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} />
    </div>
  );
}

export interface EvidenceOption {
  readonly id: string;
  readonly title: string;
}

/** Add a contact or representative, or change one (`contact`). */
export function ContactForm({
  personId,
  path,
  contact,
  documents,
}: {
  readonly personId: string;
  readonly path: string;
  readonly contact?: ContactOut;
  /** The person's documents, to choose the evidence of an authority from. */
  readonly documents: readonly EvidenceOption[];
}) {
  // Under the list's heading when adding; under the contact's own heading when changing one.
  const Heading = contact ? "h6" : "h4";
  const ids = useFieldIds(CONTACT_FIELDS);
  const { result, setResult, pending, send } = useRecordSend(path);
  const [role, setRole] = useState<string>(contact?.role ?? "");
  const authority = isAuthorityRole(role);
  const showsEndDate = authority || role === "imca" || role === "advocate";
  const field = (name: (typeof CONTACT_FIELDS)[number]) => ({
    id: ids[name],
    name,
    label: t("people.contacts.form.field", { field: name }),
    error: errorFor(result, name),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const until = showsEndDate
      ? readDateField(form, "validUntil", {
          subject: t("people.contacts.form.validUntil"),
          optional: true,
          t,
        })
      : ({ ok: true, date: null } as const);
    const read = readContactForm(form, until.ok ? until.date : null, t);
    if (!read.ok) {
      for (const [name, message] of Object.entries(read.errors)) {
        problems.push({ field: name, message });
      }
    }
    if (!until.ok)
      problems.push({ field: "validUntil", message: until.message, parts: until.parts });
    problems.sort(
      (a, b) => CONTACT_FIELDS.indexOf(a.field as never) - CONTACT_FIELDS.indexOf(b.field as never),
    );
    const refusal = collectedRefusal(problems);
    if (refusal) {
      setResult(refusal);
      return;
    }
    if (!read.ok) return;
    if (!contact) {
      send("contactAdded", () => addContact(personId, read.contact));
      return;
    }
    const changes = contactChanges(read.contact, contact);
    if (!changes) {
      setResult(collectedRefusal([{ field: "role", message: t("people.contacts.form.noChange") }]));
      return;
    }
    send(
      (saved) => (saved.suspendedDecisions > 0 ? "contactSavedSuspended" : "contactSaved"),
      () => updateContact(personId, contact.id, changes, contact.version),
    );
  };

  const open = contact
    ? t("people.contacts.change", { name: contactName(contact) })
    : t("people.contacts.add");

  return (
    <InlineSection open={open}>
      {(close) => (
        <>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <Heading className="m-0 text-body font-semibold">{open}</Heading>
            <SelectField
              {...field("role")}
              value={role}
              onChange={(event) => setRole(event.currentTarget.value)}
              emptyOption={t("people.sharing.form.choose")}
              required
              options={CONTACT_ROLES.map((value) => ({
                value,
                label: t("people.contacts.role", { role: value }),
              }))}
              className="max-w-md"
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                {...field("givenName")}
                defaultValue={contact?.givenName ?? ""}
                maxLength={100}
                required
                autoComplete="off"
              />
              <TextField
                {...field("familyName")}
                defaultValue={contact?.familyName ?? ""}
                maxLength={100}
                required
                autoComplete="off"
              />
              <TextField
                {...field("relationship")}
                defaultValue={contact?.relationship ?? ""}
                maxLength={100}
                autoComplete="off"
              />
            </div>
            <Checkbox
              id={ids.isNextOfKin}
              name="isNextOfKin"
              value="yes"
              label={t("people.contacts.form.field", { field: "isNextOfKin" })}
              defaultChecked={contact?.isNextOfKin ?? false}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                {...field("phone")}
                type="tel"
                defaultValue={contact?.phone ?? ""}
                maxLength={40}
                autoComplete="off"
              />
              <TextField
                {...field("email")}
                type="email"
                defaultValue={contact?.email ?? ""}
                maxLength={200}
                autoComplete="off"
              />
              <TextField
                {...field("addressLine1")}
                defaultValue={contact?.addressLine1 ?? ""}
                maxLength={200}
                autoComplete="off"
              />
              <TextField
                {...field("town")}
                defaultValue={contact?.town ?? ""}
                maxLength={100}
                autoComplete="off"
              />
              <TextField
                {...field("postcode")}
                defaultValue={contact?.postcode ?? ""}
                maxLength={10}
                autoComplete="off"
                className="max-w-xs"
              />
            </div>
            {showsEndDate ? (
              <fieldset className="m-0 flex flex-col gap-4 rounded-input border border-border p-4">
                <legend className="px-1 font-semibold">
                  {t("people.contacts.form.authorityTitle")}
                </legend>
                {role === "deputy" ? (
                  <RadioGroup
                    id={ids.authorityScope}
                    name="authorityScope"
                    legend={t("people.contacts.form.field", { field: "authorityScope" })}
                    error={errorFor(result, "authorityScope")}
                    {...(contact?.authorityScope ? { defaultValue: contact.authorityScope } : {})}
                    options={(["personal_welfare", "property_affairs", "both"] as const).map(
                      (scope) => ({ value: scope, label: t("people.contacts.scope", { scope }) }),
                    )}
                  />
                ) : null}
                {authority && contact ? (
                  <p className="m-0 max-w-prose text-body-dense">
                    {t("people.contacts.form.decisionsKeep")}
                  </p>
                ) : null}
                {authority ? (
                  <>
                    <TextField
                      {...field("authorityReference")}
                      defaultValue={contact?.authorityReference ?? ""}
                      hint={t("people.contacts.form.referenceHint")}
                      maxLength={120}
                      autoComplete="off"
                    />
                    <SelectField
                      {...field("authorityDocumentId")}
                      defaultValue={contact?.authorityDocumentId ?? ""}
                      hint={t("people.contacts.form.evidenceHint")}
                      emptyOption={t("people.contacts.form.noEvidence")}
                      options={documents.map((d) => ({ value: d.id, label: d.title }))}
                    />
                  </>
                ) : null}
                <DateInput
                  id={ids.validUntil}
                  name="validUntil"
                  legend={t("people.contacts.form.field", { field: "validUntil" })}
                  hint={t("people.contacts.form.validUntilHint")}
                  defaultValue={contact?.validUntil ?? null}
                  error={errorFor(result, "validUntil")}
                  errorParts={dateBoxesOf(partsFor(result, "validUntil"))}
                  labels={dateLabels()}
                />
              </fieldset>
            ) : null}
            <TextArea
              id={ids.notes}
              name="notes"
              label={t("people.contacts.form.field", { field: "notes" })}
              defaultValue={contact?.notes ?? ""}
              rows={2}
              maxLength={1000}
              formatCount={(remaining) => characterCount(remaining)}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending
                  ? t("common.saving")
                  : contact
                    ? t("people.contacts.form.submitChange")
                    : t("people.contacts.form.submitAdd")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setResult(null);
                  close();
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </form>
          {/* A refusal at its fields, or the step-up notice (a portal member's email address). */}
          <ManageFeedback
            result={result}
            path={path}
            fieldIds={ids}
            stepUp={t("people.contacts.stepUp")}
          />
        </>
      )}
    </InlineSection>
  );
}
