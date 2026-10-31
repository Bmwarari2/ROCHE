"use client";

import { Button, Checkbox, DateInput, RadioGroup, SelectField } from "@harbour/ui";
import { type FormEvent, useState } from "react";
import {
  closeSharingDecision,
  type DecisionAction,
  recordSharingDecision,
} from "@/app/actions/sharing";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { t } from "@/lib/i18n";
import { collectedRefusal, errorFor, type FieldProblem, partsFor } from "@/lib/outcome";
import { readSharingForm, SHARING_FIELDS, SHARING_SECTION_KEYS } from "@/lib/sharing";
import { dateBoxesOf, readDateField, ukToday } from "@/lib/uk-time";
import { InlineSection, ReasonAction, useRecordSend } from "./RecordForms";

/**
 * Sharing decisions (PEOP-013; people.md rule 13; HZ-022): record who sees which sections, on
 * what basis and until when, and suspend, lift or withdraw one with a reason. The API checks the
 * basis, the authority (held by the contact named, within what it covers, with evidence and in
 * date) and the capacity finding, and answers in words the form shows.
 */

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** An attorney, deputy or appointee, with the authorities they can hold. */
export interface AuthorityChoice extends Choice {
  readonly roles: readonly string[];
}

/** A capacity assessment of the sharing decision, with its finding. */
export interface AssessmentChoice extends Choice {
  readonly outcome: "has_capacity" | "lacks_capacity";
}

type RecipientKind = "family" | "professional" | "link";
type Basis = "consent" | "legal_authority" | "best_interests" | "direct_care";
type Capacity = "presumed" | "assessed_has_capacity" | "assessed_lacks_capacity";

function SectionBoxes({
  id,
  name,
  legend,
  hint,
  error,
  sections,
}: {
  readonly id: string;
  readonly name: string;
  readonly legend: string;
  readonly hint?: string;
  readonly error: string | undefined;
  readonly sections: readonly string[];
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <fieldset
      className="m-0 flex flex-col gap-1 border-0 p-0"
      aria-describedby={[hint ? hintId : "", error ? errorId : ""].join(" ").trim() || undefined}
    >
      <legend className="mb-1 p-0 font-semibold">{legend}</legend>
      {hint ? (
        <p id={hintId} className="hb-field__hint m-0">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="hb-field__error m-0">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        {sections.map((section, index) => (
          <Checkbox
            key={section}
            {...(index === 0 ? { id } : {})}
            name={name}
            value={section}
            label={t("people.sharing.sectionName", { section })}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
        ))}
      </div>
    </fieldset>
  );
}

export function SharingDecisionForm({
  personId,
  path,
  contacts,
  professionals,
  authorities,
  assessments,
  bestInterests,
}: {
  readonly personId: string;
  readonly path: string;
  /** The person's contacts, as family members or representatives who can be shared with. */
  readonly contacts: readonly Choice[];
  /** Members of staff and professionals; null when the list cannot be read here. */
  readonly professionals: readonly Choice[] | null;
  readonly authorities: readonly AuthorityChoice[];
  readonly assessments: readonly AssessmentChoice[];
  readonly bestInterests: readonly Choice[];
}) {
  const ids = useFieldIds(SHARING_FIELDS);
  const { result, setResult, pending, send } = useRecordSend(path);
  const [kind, setKind] = useState<RecipientKind | null>(null);
  const [contactId, setContactId] = useState("");
  const [basis, setBasis] = useState<Basis | null>(null);
  const [consentBy, setConsentBy] = useState<"person" | "authority_holder" | null>(null);
  const [authorityContact, setAuthorityContact] = useState("");
  const [authorityRole, setAuthorityRole] = useState("");
  const [capacity, setCapacity] = useState<Capacity>("presumed");

  const legalAuthority = basis === "legal_authority";
  const needsAuthority =
    legalAuthority || (basis === "consent" && consentBy === "authority_holder");
  // A legal authority is held by the family member it shares with (rule 13).
  const holder = legalAuthority && kind === "family" ? contactId : authorityContact;
  const holderRoles = authorities.find((a) => a.value === holder)?.roles ?? [];
  const role = holderRoles.length === 1 ? (holderRoles[0] ?? "") : authorityRole;
  const finding = capacity === "assessed_lacks_capacity" ? "lacks_capacity" : "has_capacity";
  const assessmentChoices = assessments.filter((a) => a.outcome === finding);
  const kinds: RecipientKind[] = professionals
    ? ["family", "professional", "link"]
    : ["family", "link"];

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (holderRoles.length === 1) form.set("authorityRole", role);
    const problems: FieldProblem[] = [];
    const until = readDateField(form, "validTo", {
      subject: t("people.sharing.form.validToDate"),
      t,
    });
    const read = readSharingForm(form, until.ok ? until.date : null, ukToday(), t);
    if (!read.ok) {
      for (const [field, message] of Object.entries(read.errors)) {
        if (field === "validTo" && !until.ok) continue;
        problems.push({ field, message });
      }
    }
    if (!until.ok) problems.push({ field: "validTo", message: until.message, parts: until.parts });
    problems.sort(
      (a, b) => SHARING_FIELDS.indexOf(a.field as never) - SHARING_FIELDS.indexOf(b.field as never),
    );
    const refusal = collectedRefusal(problems);
    if (refusal) {
      setResult(refusal);
      return;
    }
    if (read.ok) send("recorded", () => recordSharingDecision(personId, read.decision));
  };

  return (
    <InlineSection open={t("people.sharing.form.title")}>
      {(close) => (
        <>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <h4 className="m-0 text-body font-semibold">{t("people.sharing.form.title")}</h4>
            <RadioGroup<RecipientKind>
              id={ids.recipientKind}
              name="recipientKind"
              legend={t("people.sharing.form.recipient")}
              error={errorFor(result, "recipientKind")}
              value={kind}
              onValueChange={setKind}
              options={kinds.map((value) => ({
                value,
                label: t("people.sharing.form.recipientKind", { kind: value }),
              }))}
            />
            {kind === "family" ? (
              contacts.length > 0 ? (
                <SelectField
                  id={ids.contactId}
                  name="contactId"
                  label={t("people.sharing.form.contact")}
                  emptyOption={t("people.sharing.form.choose")}
                  required
                  value={contactId}
                  onChange={(event) => setContactId(event.currentTarget.value)}
                  error={errorFor(result, "contactId")}
                  options={contacts}
                />
              ) : (
                <p className="m-0 max-w-prose">{t("people.sharing.form.noContacts")}</p>
              )
            ) : null}
            {kind === "professional" && professionals ? (
              <SelectField
                id={ids.tenantUserId}
                name="tenantUserId"
                label={t("people.sharing.form.professional")}
                emptyOption={t("people.sharing.form.choose")}
                required
                error={errorFor(result, "tenantUserId")}
                options={professionals}
              />
            ) : null}
            <SectionBoxes
              id={ids.sections}
              name="sections"
              legend={t("people.sharing.form.sections")}
              hint={t("people.sharing.form.sectionsHint")}
              error={errorFor(result, "sections")}
              sections={kind === "link" ? ["about_me"] : SHARING_SECTION_KEYS}
            />
            <RadioGroup<Basis>
              id={ids.basis}
              name="basis"
              legend={t("people.sharing.form.basis")}
              error={errorFor(result, "basis")}
              value={basis}
              onValueChange={setBasis}
              options={(
                ["consent", "legal_authority", "best_interests", "direct_care"] as const
              ).map((value) => ({
                value,
                label: t("people.sharing.basis", { basis: value }),
                description: t("people.sharing.basisHint", { basis: value }),
              }))}
            />
            {basis === "consent" ? (
              <RadioGroup<"person" | "authority_holder">
                id={ids.consentGivenBy}
                name="consentGivenBy"
                legend={t("people.sharing.form.consentBy")}
                error={errorFor(result, "consentGivenBy")}
                value={consentBy}
                onValueChange={setConsentBy}
                options={(["person", "authority_holder"] as const).map((value) => ({
                  value,
                  label: t("people.sharing.consentBy", { by: value }),
                }))}
              />
            ) : null}
            {needsAuthority ? (
              authorities.length === 0 ? (
                <p className="m-0 max-w-prose">{t("people.sharing.form.noAuthorities")}</p>
              ) : (
                <fieldset className="m-0 flex flex-col gap-4 rounded-input border border-border p-4">
                  <legend className="px-1 font-semibold">
                    {t("people.sharing.form.authorityRole")}
                  </legend>
                  {legalAuthority && kind === "family" ? null : (
                    <SelectField
                      id={ids.authorityContactId}
                      name="authorityContactId"
                      label={t("people.sharing.form.authorityContact")}
                      hint={t("people.sharing.form.authorityContactHint")}
                      emptyOption={t("people.sharing.form.choose")}
                      required
                      value={authorityContact}
                      onChange={(event) => setAuthorityContact(event.currentTarget.value)}
                      error={errorFor(result, "authorityContactId")}
                      options={authorities}
                    />
                  )}
                  {holder && holderRoles.length === 0 ? (
                    <p className="m-0 max-w-prose" id={ids.authorityRole}>
                      {t("people.sharing.form.noAuthorityHeld")}
                    </p>
                  ) : (
                    <SelectField
                      id={ids.authorityRole}
                      name="authorityRole"
                      label={t("people.sharing.form.authorityRole")}
                      emptyOption={t("people.sharing.form.choose")}
                      required
                      value={role}
                      onChange={(event) => setAuthorityRole(event.currentTarget.value)}
                      error={errorFor(result, "authorityRole")}
                      options={holderRoles.map((value) => ({
                        value,
                        label: t("people.sharing.authorityRole", { role: value }),
                      }))}
                    />
                  )}
                  {role.startsWith("deputy_") ? (
                    <SectionBoxes
                      id={ids.orderSections}
                      name="orderSections"
                      legend={t("people.sharing.form.orderSections")}
                      error={errorFor(result, "orderSections")}
                      sections={SHARING_SECTION_KEYS}
                    />
                  ) : null}
                </fieldset>
              )
            ) : null}
            <RadioGroup<Capacity>
              id={ids.capacity}
              name="capacity"
              legend={t("people.sharing.form.capacity")}
              error={errorFor(result, "capacity")}
              value={capacity}
              onValueChange={setCapacity}
              options={(
                ["presumed", "assessed_has_capacity", "assessed_lacks_capacity"] as const
              ).map((value) => ({
                value,
                label: t("people.sharing.capacity", { capacity: value }),
              }))}
            />
            {capacity !== "presumed" ? (
              assessmentChoices.length > 0 ? (
                <SelectField
                  id={ids.capacityAssessmentId}
                  name="capacityAssessmentId"
                  label={t("people.sharing.form.assessment")}
                  emptyOption={t("people.sharing.form.choose")}
                  required
                  error={errorFor(result, "capacityAssessmentId")}
                  options={assessmentChoices}
                />
              ) : (
                <p className="m-0 max-w-prose" id={ids.capacityAssessmentId}>
                  {t("people.sharing.form.noAssessment")}
                </p>
              )
            ) : null}
            {basis === "best_interests" ? (
              bestInterests.length > 0 ? (
                <SelectField
                  id={ids.bestInterestsDecisionId}
                  name="bestInterestsDecisionId"
                  label={t("people.sharing.form.bestInterests")}
                  emptyOption={t("people.sharing.form.choose")}
                  required
                  error={errorFor(result, "bestInterestsDecisionId")}
                  options={bestInterests}
                />
              ) : (
                <p className="m-0 max-w-prose" id={ids.bestInterestsDecisionId}>
                  {t("people.sharing.form.noBestInterests")}
                </p>
              )
            ) : null}
            <DateInput
              id={ids.validTo}
              name="validTo"
              legend={t("people.sharing.form.validTo")}
              hint={t("people.sharing.form.validToHint")}
              error={errorFor(result, "validTo")}
              errorParts={dateBoxesOf(partsFor(result, "validTo"))}
              labels={{
                day: t("care.date.day"),
                month: t("care.date.month"),
                year: t("care.date.year"),
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? t("common.saving") : t("people.sharing.form.submit")}
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
          <FormFeedback
            result={result}
            success={t("people.sharing.done", { action: "recorded" })}
            fieldIds={ids}
          />
        </>
      )}
    </InlineSection>
  );
}

/** Suspend, lift a suspension or withdraw one decision, with the reason. */
export function DecisionActionForm({
  personId,
  path,
  decisionId,
  version,
  action,
  recipient,
}: {
  readonly personId: string;
  readonly path: string;
  readonly decisionId: string;
  readonly version: number;
  readonly action: DecisionAction;
  /** Who the decision shares with, so each button names the decision it acts on. */
  readonly recipient: string;
}) {
  return (
    <ReasonAction
      open={t("people.sharing.actionFor", { action, recipient })}
      label={t("people.sharing.reason", { action })}
      {...(action === "suspend" ? { hint: t("people.sharing.reasonHint") } : {})}
      consequence={t("people.sharing.consequence", { action })}
      submit={t("people.sharing.action", { action })}
      path={path}
      done={action}
      destructive={action === "withdraw"}
      onSend={(reason) => closeSharingDecision(personId, decisionId, action, reason, version)}
    />
  );
}
