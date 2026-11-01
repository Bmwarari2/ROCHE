"use client";

import type { SpeakUpState } from "@harbour/contracts";
import { Button, Checkbox, RadioGroup, SelectField, TextArea } from "@harbour/ui";
import { Megaphone, Send, Users } from "lucide-react";
import {
  raiseSpeakUp,
  replyToMyConcern,
  setSpeakUpMembers,
  stepSpeakUpCase,
  writeOnCase,
} from "@/app/actions/safety-silos";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { uuidv7 } from "@/lib/entry-id";
import { characterCount, t } from "@/lib/i18n";
import { errorFor } from "@/lib/outcome";
import {
  readMessage,
  readRaiseSpeakUp,
  readSpeakUpStep,
  SPEAK_UP_CATEGORIES,
  SPEAK_UP_MESSAGE_MAX,
  SPEAK_UP_SUMMARY_MAX,
} from "@/lib/speak-up";
import { useSubmit } from "./use-submit";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/** The category and what happened: shared by the signed-in form and the public page. */
export function ConcernFields({
  ids,
  errors,
}: {
  readonly ids: { readonly category: string; readonly summary: string };
  readonly errors: {
    readonly category?: string | undefined;
    readonly summary?: string | undefined;
  };
}) {
  return (
    <>
      <SelectField
        id={ids.category}
        name="category"
        label={t("speakUp.form.category")}
        defaultValue=""
        options={[
          { value: "", label: t("speakUp.form.categoryChoose") },
          ...SPEAK_UP_CATEGORIES.map((value) => ({
            value,
            label: t("speakUp.category", { value }),
          })),
        ]}
        {...(errors.category ? { error: errors.category } : {})}
      />
      <TextArea
        id={ids.summary}
        name="summary"
        label={t("speakUp.form.summary")}
        hint={t("speakUp.form.summaryHint")}
        rows={6}
        maxLength={SPEAK_UP_SUMMARY_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        {...(errors.summary ? { error: errors.summary } : {})}
      />
    </>
  );
}

/** A member raising a concern: named to everyone on the case, or confidential to the lead. */
export function RaiseSpeakUpForm() {
  const ids = useFieldIds(["identity", "category", "summary"]);
  const { submit, result, pending } = useSubmit(
    (form) => readRaiseSpeakUp(form, t, { id: uuidv7() }),
    raiseSpeakUp,
    (_data, form) => form.reset(),
  );
  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RadioGroup
        id={ids.identity}
        name="identity"
        legend={t("speakUp.form.identity")}
        options={[
          {
            value: "named",
            label: t("speakUp.identity", { value: "named" }),
            description: t("speakUp.identityHint", { value: "named" }),
          },
          {
            value: "confidential",
            label: t("speakUp.identity", { value: "confidential" }),
            description: t("speakUp.identityHint", { value: "confidential" }),
          },
        ]}
        error={errorFor(result, "identity")}
      />
      <ConcernFields
        ids={ids}
        errors={{ category: errorFor(result, "category"), summary: errorFor(result, "summary") }}
      />
      <div>
        <Button type="submit" icon={<Megaphone {...icon} />} disabled={pending}>
          {pending ? t("speakUp.pending.sending") : t("speakUp.form.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("speakUp.form.done")} fieldIds={ids} />
    </form>
  );
}

/** A message: from the reporter on their own concern, or from the lead or a member on the case. */
export function SpeakUpMessageForm({
  id,
  mode,
}: {
  readonly id: string;
  readonly mode: "mine" | "case";
}) {
  const ids = useFieldIds(["body"]);
  const { submit, result, pending } = useSubmit(
    (form) => readMessage(form, t),
    ({ body }) => (mode === "mine" ? replyToMyConcern(id, body) : writeOnCase(id, body)),
    (_data, form) => form.reset(),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <TextArea
        id={ids.body}
        name="body"
        label={t(mode === "mine" ? "speakUp.message.reply" : "speakUp.message.toReporter")}
        rows={3}
        maxLength={SPEAK_UP_MESSAGE_MAX}
        formatCount={(remaining) => characterCount(remaining)}
        error={errorFor(result, "body")}
      />
      <div>
        <Button type="submit" variant="secondary" icon={<Send {...icon} />} disabled={pending}>
          {pending ? t("speakUp.pending.sending") : t("speakUp.message.send")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("speakUp.message.done")} fieldIds={ids} />
    </form>
  );
}

/** The lead's step on a case: sharing the outcome in words, or closing with a reason. */
export function SpeakUpStepForm({
  id,
  version,
  to,
}: {
  readonly id: string;
  readonly version: number;
  readonly to: SpeakUpState;
}) {
  const ids = useFieldIds(["outcome", "reason"]);
  const { submit, result, pending } = useSubmit(
    (form) => readSpeakUpStep(form, t, { to, version }),
    (body) => stepSpeakUpCase(id, body),
    undefined,
    t("speakUp.step.done"),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      {to === "outcome_shared" ? (
        <TextArea
          id={ids.outcome}
          name="outcome"
          label={t("speakUp.step.outcome")}
          hint={t("speakUp.step.outcomeHint")}
          rows={4}
          maxLength={SPEAK_UP_MESSAGE_MAX}
          formatCount={(remaining) => characterCount(remaining)}
          error={errorFor(result, "outcome")}
        />
      ) : null}
      {to === "closed" ? <p className="m-0">{t("speakUp.step.closeFinal")}</p> : null}
      {to === "closed" ? (
        <TextArea
          id={ids.reason}
          name="reason"
          label={t("speakUp.step.reason")}
          rows={2}
          maxLength={2_000}
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
          {pending ? t("common.saving") : t("speakUp.step.submit", { to })}
        </Button>
      </div>
      <FormFeedback result={result} success={t("speakUp.step.done")} fieldIds={ids} />
    </form>
  );
}

/** The lead names the members who work on the case; unticking removes one (kept in the history). */
export function SpeakUpMembersForm({
  id,
  staff,
  members,
}: {
  readonly id: string;
  readonly staff: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly jobTitle: string | null;
  }[];
  readonly members: readonly string[];
}) {
  const ids = useFieldIds(["memberIds"]);
  const { submit, result, pending } = useSubmit(
    (form) => ({
      ok: true as const,
      body: form.getAll("memberIds").filter((v): v is string => typeof v === "string"),
    }),
    (memberIds) => setSpeakUpMembers(id, memberIds),
  );
  return (
    <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <fieldset
        id={ids.memberIds}
        aria-describedby={`${ids.memberIds}-hint`}
        className="m-0 flex flex-col gap-1 border-0 p-0"
      >
        <legend className="mb-2 text-body font-semibold">{t("speakUp.members.legend")}</legend>
        <p id={`${ids.memberIds}-hint`} className="m-0 mb-2 text-body-dense text-text-secondary">
          {t("speakUp.members.hint")}
        </p>
        {staff.map((person) => (
          <Checkbox
            key={person.id}
            name="memberIds"
            value={person.id}
            defaultChecked={members.includes(person.id)}
            label={
              person.jobTitle
                ? t("speakUp.members.option", { name: person.displayName, role: person.jobTitle })
                : person.displayName
            }
          />
        ))}
      </fieldset>
      <div>
        <Button type="submit" variant="secondary" icon={<Users {...icon} />} disabled={pending}>
          {pending ? t("common.saving") : t("speakUp.members.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("speakUp.members.done")} fieldIds={ids} />
    </form>
  );
}
