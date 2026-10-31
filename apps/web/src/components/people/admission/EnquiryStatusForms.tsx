"use client";

import { Button, RadioGroup, SelectField, TextArea } from "@harbour/ui";
import { CircleX, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { changeEnquiryStatus } from "@/app/actions/admission";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, fieldErrors } from "@/lib/outcome";
import { useActionForm } from "./action-form";

export const PLACEMENT_TYPES = ["permanent", "respite", "trial", "package"] as const;

const START_FIELDS = ["serviceId", "placementTypeSought"] as const;

/**
 * Start the pre-admission assessment (people.md rule 1: enquiry to pre-admission,
 * people.enquiry.manage): what is being sought, so the assessment and the admission that may
 * follow start from it.
 */
export function StartAssessmentForm({
  personId,
  version,
  services,
}: {
  readonly personId: string;
  readonly version: number;
  readonly services: readonly { readonly id: string; readonly name: string }[];
}) {
  const router = useRouter();
  const form = useActionForm();
  const ids = useFieldIds(START_FIELDS);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const serviceId = String(data.get("serviceId") ?? "");
    const placementTypeSought = String(data.get("placementTypeSought") ?? "");
    if (!serviceId || !placementTypeSought) {
      form.setResult(
        fieldErrors({
          ...(!serviceId ? { serviceId: t("people.preAdmission.start.serviceRequired") } : {}),
          ...(!placementTypeSought
            ? { placementTypeSought: t("people.preAdmission.start.typeRequired") }
            : {}),
        }),
      );
      return;
    }
    form.run(
      () =>
        changeEnquiryStatus(personId, version, {
          to: "pre_admission",
          serviceId,
          placementTypeSought,
        }),
      () => router.push(`/people/${personId}/pre-admission?done=started`, { scroll: false }),
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <SelectField
          id={ids.serviceId}
          name="serviceId"
          label={t("people.preAdmission.start.service")}
          emptyOption={t("people.preAdmission.start.serviceChoose")}
          required
          options={services.map((s) => ({ value: s.id, label: s.name }))}
          error={errorFor(form.result, "serviceId")}
          className="max-w-md"
        />
        <RadioGroup
          id={ids.placementTypeSought}
          name="placementTypeSought"
          legend={t("people.preAdmission.start.type")}
          layout="inline"
          required
          error={errorFor(form.result, "placementTypeSought")}
          options={PLACEMENT_TYPES.map((type) => ({
            value: type,
            label: t("people.placementType", { type }),
          }))}
        />
        <div>
          <Button type="submit" disabled={form.pending}>
            {form.pending ? t("common.saving") : t("people.preAdmission.start.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback
        result={form.result}
        success={t("people.preAdmission.start.saved")}
        fieldIds={ids}
      />
    </div>
  );
}

const REASON_FIELDS = ["reason"] as const;

/**
 * Close an enquiry or assessment as not admitted, or record a re-referral of someone not admitted
 * (people.enquiry.manage, with a reason). Opens in place; Cancel puts focus back on its button.
 */
export function EnquiryReasonForm({
  personId,
  version,
  to,
}: {
  readonly personId: string;
  readonly version: number;
  readonly to: "not_admitted" | "enquiry";
}) {
  const router = useRouter();
  const form = useActionForm();
  const inline = useInlineForm<HTMLTextAreaElement>();
  const ids = useFieldIds(REASON_FIELDS);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    if (reason.trim().length < 3) {
      form.setResult(fieldErrors({ reason: t("people.preAdmission.close.reasonRequired") }));
      return;
    }
    form.run(
      () => changeEnquiryStatus(personId, version, { to, reason }),
      () =>
        to === "not_admitted"
          ? router.push("/people/pre-admission?done=closed")
          : router.push(`/people/${personId}/pre-admission?done=rereferred`, { scroll: false }),
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {inline.open ? (
        <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
          {to === "not_admitted" ? (
            <p className="m-0 font-semibold">{t("people.preAdmission.close.consequence")}</p>
          ) : null}
          <TextArea
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={t("people.preAdmission.close.reason", { to })}
            hint={t("people.preAdmission.close.reasonHint")}
            rows={3}
            required
            maxLength={1000}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(form.result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant={to === "not_admitted" ? "destructive" : "primary"}
              disabled={form.pending}
            >
              {t("people.preAdmission.close.submit", { to })}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                form.setResult(null);
                inline.hide();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            ref={inline.trigger}
            variant="secondary"
            icon={
              to === "not_admitted" ? (
                <CircleX size={16} strokeWidth={1.5} />
              ) : (
                <RotateCcw size={16} strokeWidth={1.5} />
              )
            }
            onClick={() => {
              form.setResult(null);
              inline.show();
            }}
          >
            {t("people.preAdmission.close.open", { to })}
          </Button>
        </div>
      )}
      <FormFeedback
        result={form.result}
        success={t("people.preAdmission.close.saved", { to })}
        fieldIds={ids}
      />
    </div>
  );
}
