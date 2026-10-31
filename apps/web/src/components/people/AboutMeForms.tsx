"use client";

import type { AboutMeOut, AboutMeShareLinkCreated } from "@harbour/contracts";
import { Button, DateInput, RadioGroup, SelectField, TextArea, TextField } from "@harbour/ui";
import { KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { makeShareLink, revokeShareLink, saveAboutMe } from "@/app/actions/sharing";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { collectedRefusal, errorFor, type FieldProblem, partsFor } from "@/lib/outcome";
import {
  ABOUT_ME_KEYS,
  ABOUT_ME_TEXT_MAX,
  aboutMeMediaCount,
  aboutMeText,
  linkExpiry,
  readAboutMeForm,
  SUPPORTER_MAX,
} from "@/lib/sharing";
import { dateBoxesOf, readDateField, ukToday } from "@/lib/uk-time";
import { InlineSection, LINK_REASON_MAX, ReasonAction, useRecordSend } from "./RecordForms";

/**
 * About me (PEOP-003; people.md rule 9): write or change it with the person, in their words, and
 * make or revoke a share link under a sharing decision (rule 13; HZ-022). The link's code is shown
 * once, here, and never again.
 */

const ABOUT_ME_FIELDS = ["authoredBy", "supporter", ...ABOUT_ME_KEYS] as const;

export function AboutMeForm({
  personId,
  path,
  about,
  name,
}: {
  readonly personId: string;
  readonly path: string;
  readonly about: AboutMeOut;
  /** The person's preferred name, for the choices "Ada, in their own words". */
  readonly name: string;
}) {
  const ids = useFieldIds(ABOUT_ME_FIELDS);
  const { result, setResult, pending, send } = useRecordSend(path);
  const written = about.version > 0;
  const supporter = (about.sections.supported_to_write_this_by ?? "") as string;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readAboutMeForm(new FormData(event.currentTarget), about, t);
    if (!read.ok) {
      setResult(
        collectedRefusal(
          ABOUT_ME_FIELDS.flatMap((field) =>
            read.errors[field] ? [{ field, message: read.errors[field] }] : [],
          ),
        ),
      );
      return;
    }
    send("aboutMe", () => saveAboutMe(personId, read.update, about.version));
  };

  return (
    <InlineSection open={t("people.aboutMe.edit", { written: written ? "yes" : "no" })}>
      {(close) => (
        <>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <h4 className="m-0 text-body font-semibold">
              {t("people.aboutMe.edit", { written: written ? "yes" : "no" })}
            </h4>
            <RadioGroup
              id={ids.authoredBy}
              name="authoredBy"
              legend={t("people.aboutMe.form.who")}
              error={errorFor(result, "authoredBy")}
              {...(written
                ? { defaultValue: about.authoredByPerson ? "person" : "supported" }
                : {})}
              options={[
                { value: "person", label: t("people.aboutMe.form.byPerson", { name }) },
                { value: "supported", label: t("people.aboutMe.form.supported", { name }) },
              ]}
            />
            <TextField
              id={ids.supporter}
              name="supporter"
              label={t("people.aboutMe.form.supporter")}
              hint={t("people.aboutMe.form.supporterHint")}
              defaultValue={supporter}
              maxLength={SUPPORTER_MAX}
              autoComplete="off"
              error={errorFor(result, "supporter")}
            />
            {ABOUT_ME_KEYS.map((key) => {
              const media = aboutMeMediaCount(about, key);
              return (
                <TextArea
                  key={key}
                  id={ids[key]}
                  name={key}
                  label={t("people.aboutMe.section", { section: key })}
                  hint={
                    media > 0
                      ? `${t("people.aboutMe.form.partHint")} ${t("people.aboutMe.form.mediaKept")}`
                      : t("people.aboutMe.form.partHint")
                  }
                  defaultValue={aboutMeText(about, key) ?? ""}
                  rows={3}
                  maxLength={ABOUT_ME_TEXT_MAX}
                  formatCount={(remaining) => characterCount(remaining)}
                  error={errorFor(result, key)}
                />
              );
            })}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? t("common.saving") : t("people.aboutMe.form.submit")}
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
          <FormFeedback result={result} success={t("people.aboutMe.saved")} fieldIds={ids} />
        </>
      )}
    </InlineSection>
  );
}

export interface LinkDecisionOption {
  readonly id: string;
  readonly label: string;
  readonly validTo: string;
  /** The decision's last day, as dd/mm/yyyy, for the error that says so. */
  readonly lastDay: string;
}

/**
 * Make a share link under a decision for a share link that covers About me and is in force. It
 * needs a fresh sign-in (the API says so, and this form then asks for the passkey or code). The
 * code comes back once and is shown here, with focus, until the page is left.
 */
export function ShareLinkForm({
  personId,
  path,
  decisions,
}: {
  readonly personId: string;
  readonly path: string;
  readonly decisions: readonly LinkDecisionOption[];
}) {
  const ids = useFieldIds(["sharingDecisionId", "expiresAt", "token"]);
  const { result, setResult, pending, send } = useRecordSend(path);
  const [made, setMade] = useState<AboutMeShareLinkCreated | null>(null);
  const madeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (made) madeRef.current?.focus();
  }, [made]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const decision = decisions.find((d) => d.id === String(form.get("sharingDecisionId") ?? ""));
    if (!decision) {
      problems.push({
        field: "sharingDecisionId",
        message: t("people.links.form.decisionRequired"),
      });
    }
    const day = readDateField(form, "expiresAt", {
      subject: t("people.links.form.expiresDate"),
      t,
    });
    let expiresAt: string | null = null;
    if (!day.ok) {
      problems.push({ field: "expiresAt", message: day.message, parts: day.parts });
    } else if (decision && day.date) {
      const expiry = linkExpiry(day.date, decision.validTo, ukToday());
      if (expiry.ok) expiresAt = expiry.expiresAt;
      else {
        problems.push({
          field: "expiresAt",
          message:
            expiry.problem === "past"
              ? t("people.links.form.expiresPast")
              : t("people.links.form.expiresAfterDecision", { date: decision.lastDay }),
        });
      }
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !decision || !expiresAt) {
      setResult(refusal);
      return;
    }
    const until = expiresAt;
    setMade(null);
    send(
      "linkMade",
      async () => {
        const outcome = await makeShareLink(personId, decision.id, until);
        if (outcome.ok) setMade(outcome.data);
        return outcome;
      },
      () => true,
    );
  };

  if (made) {
    return (
      <div
        ref={madeRef}
        tabIndex={-1}
        role="status"
        className="flex flex-col gap-3 rounded-input border-s-4 border-success bg-bg-secondary p-4"
        data-link-made=""
      >
        <p className="m-0 inline-flex items-center gap-2 font-semibold">
          <KeyRound size={18} strokeWidth={1.5} aria-hidden="true" />
          {t("people.links.created")}
        </p>
        <TextField
          id={ids.token}
          label={t("people.links.token")}
          hint={t("people.links.tokenHint")}
          value={made.token}
          readOnly
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
        <p className="m-0 max-w-prose text-body-dense text-text-secondary">
          {t("people.links.viewerPending")}
        </p>
        <div>
          <Button variant="secondary" onClick={() => setMade(null)}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <SelectField
          id={ids.sharingDecisionId}
          name="sharingDecisionId"
          label={t("people.links.form.decision")}
          hint={t("people.links.form.decisionHint")}
          emptyOption={t("people.sharing.form.choose")}
          required
          error={errorFor(result, "sharingDecisionId")}
          options={decisions.map((d) => ({ value: d.id, label: d.label }))}
        />
        <DateInput
          id={ids.expiresAt}
          name="expiresAt"
          legend={t("people.links.form.expires")}
          hint={t("people.links.form.expiresHint")}
          error={errorFor(result, "expiresAt")}
          errorParts={dateBoxesOf(partsFor(result, "expiresAt"))}
          labels={{
            day: t("care.date.day"),
            month: t("care.date.month"),
            year: t("care.date.year"),
          }}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("people.links.form.submit")}
          </Button>
        </div>
      </form>
      <ManageFeedback
        result={result}
        path={path}
        fieldIds={ids}
        stepUp={t("people.links.stepUp")}
      />
    </div>
  );
}

export function RevokeLink({
  personId,
  path,
  linkId,
  version,
  made,
}: {
  readonly personId: string;
  readonly path: string;
  readonly linkId: string;
  readonly version: number;
  /** When it was made, as shown, to name the link on its button. */
  readonly made: string;
}) {
  return (
    <ReasonAction
      open={t("people.links.revoke", { dateTime: made })}
      label={t("people.links.revokeReason")}
      consequence={t("people.links.revokeConsequence")}
      submit={t("people.links.revokeSubmit")}
      path={path}
      done="linkRevoked"
      destructive
      max={LINK_REASON_MAX}
      onSend={(reason) => revokeShareLink(personId, linkId, reason, version)}
    />
  );
}
