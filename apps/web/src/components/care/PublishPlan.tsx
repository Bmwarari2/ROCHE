"use client";

import type { SignOffCarePlan } from "@harbour/contracts";
import {
  Button,
  DateInput,
  RadioGroup,
  SelectField,
  Sheet,
  SheetClose,
  TextArea,
  TextField,
} from "@harbour/ui";
import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { publishCarePlan } from "@/app/actions/care-plan";
import { SIGN_OFF_AUTHORITIES } from "@/lib/care-plan";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { readDateField } from "@/lib/uk-time";
import { FormFeedback } from "./FormFeedback";

type AgreedBy = SignOffCarePlan["agreedBy"];

/**
 * "Publish the care plan" (care.md rule 2, hazard HZ-024): records who agreed the draft (the
 * person, a representative with their authority, or why no one could) and puts it in use. The
 * plan in use now is superseded and stays readable in the history.
 */
export function PublishPlan({
  personId,
  planId,
  version,
  name,
}: {
  readonly personId: string;
  readonly planId: string;
  readonly version: number;
  readonly name: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [agreedBy, setAgreedBy] = useState<AgreedBy | null>(null);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const review = readDateField(form, "reviewDueOn", {
      subject: t("care.date.subject.reviewDueOn"),
      optional: true,
      t,
    });
    if (!review.ok) {
      setResult(refused(review.message));
      return;
    }
    startTransition(async () => {
      const outcome = await publishCarePlan(personId, planId, {
        version,
        agreedBy,
        representativeName: String(form.get("representativeName") ?? ""),
        authority: String(form.get("authority") ?? "") as SignOffCarePlan["authority"] | "",
        unableReason: String(form.get("unableReason") ?? ""),
        reviewDueOn: review.date ?? "",
      });
      setResult(outcome);
      if (outcome.ok) {
        setOpen(false);
        router.push(`/people/${personId}/care-plan?published=1`);
      }
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setResult(null);
      }}
      trigger={
        <Button icon={<Send size={18} strokeWidth={1.5} />}>{t("care.plan.publish.open")}</Button>
      }
      title={t("care.plan.publish.title")}
      description={t("care.plan.publish.body")}
      closeLabel={t("common.close")}
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <RadioGroup<AgreedBy>
          legend={t("care.plan.publish.agreedBy")}
          name="agreedBy"
          value={agreedBy}
          onValueChange={setAgreedBy}
          options={[
            { value: "person", label: t("care.plan.publish.person", { name }) },
            {
              value: "representative",
              label: t("care.plan.publish.representative", { name }),
              description: t("care.plan.publish.representativeHint"),
            },
            { value: "unable", label: t("care.plan.publish.unable") },
          ]}
        />
        {agreedBy === "representative" ? (
          <>
            <TextField
              name="representativeName"
              label={t("care.plan.publish.representativeName")}
              maxLength={200}
            />
            <SelectField
              name="authority"
              label={t("care.plan.publish.authority")}
              emptyOption={t("care.plan.publish.authorityEmpty")}
              options={SIGN_OFF_AUTHORITIES.map((authority) => ({
                value: authority,
                label: t("care.plan.authorityOption", { authority }),
              }))}
            />
          </>
        ) : null}
        {agreedBy === "unable" ? (
          <TextArea
            name="unableReason"
            label={t("care.plan.publish.unableReason")}
            rows={3}
            maxLength={1000}
            formatCount={(remaining) => characterCount(remaining)}
          />
        ) : null}
        <DateInput
          legend={t("care.plan.publish.reviewDueOn")}
          hint={t("care.plan.publish.reviewHint")}
          name="reviewDueOn"
          labels={{
            day: t("care.date.day"),
            month: t("care.date.month"),
            year: t("care.date.year"),
          }}
        />
        <FormFeedback result={result} success={t("care.plan.published.toast")} />
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("common.cancel")}</Button>
          </SheetClose>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.plan.publish.submit")}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
