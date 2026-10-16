"use client";

import { Button, RadioGroup, SelectField } from "@harbour/ui";
import { Ban, Check, FileCheck, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import {
  acceptSetting,
  chooseStaffFileOption,
  decideRetention,
  recordDcb0160,
} from "@/app/actions/onboarding";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import { ONBOARDING_PAGE, STAFF_FILE_OPTIONS } from "@/lib/onboarding";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Sends a decision and, once recorded, opens the page again saying so (a new `at`). */
function useDecision() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (call: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        router.replace(`${ONBOARDING_PAGE}?done=decided&at=${Date.now()}`, { scroll: false });
      }
    });
  return { result, setResult, pending, send };
}

export type Reviewer = { readonly id: string; readonly name: string };

/** "Reviewed by the clinical lead or CSO": an active member, named before the decision is sent. */
function ReviewerField({
  id,
  label,
  reviewers,
  result,
}: {
  readonly id: string;
  readonly label: string;
  readonly reviewers: readonly Reviewer[];
  readonly result: ActionResult<unknown> | null;
}) {
  return (
    <SelectField
      id={id}
      name="reviewer"
      label={label}
      emptyOption={t("onboarding.reviewer.empty")}
      options={reviewers.map((r) => ({ value: r.id, label: r.name }))}
      error={errorFor(result, "reviewer")}
    />
  );
}

/**
 * Accepts a setting Harbour chose, showing the figure accepted; a later change by Harbour reopens
 * it. A clinical setting is confirmed with the clinical lead or CSO who reviewed it (HZ-027).
 */
export function AcceptSetting({
  rateKey,
  value,
  clinical,
  reviewers,
}: {
  readonly rateKey: string;
  readonly value: { readonly value: number; readonly unit: string } | null;
  readonly clinical: boolean;
  readonly reviewers: readonly Reviewer[];
}) {
  const { result, setResult, pending, send } = useDecision();
  const ids = useFieldIds(["reviewer"] as const);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reviewer = String(new FormData(event.currentTarget).get("reviewer") ?? "");
    if (clinical && !reviewer) {
      setResult(fieldErrors({ reviewer: t("onboarding.reviewer.required") }));
      return;
    }
    send(() => acceptSetting(rateKey, clinical ? reviewer : undefined));
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
      <p className="m-0">
        {value
          ? t("onboarding.setting.value", { value: value.value, unit: value.unit })
          : t("onboarding.setting.noValue")}
      </p>
      {clinical ? (
        <ReviewerField
          id={ids.reviewer}
          label={t("onboarding.reviewer.setting")}
          reviewers={reviewers}
          result={result}
        />
      ) : null}
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={pending}
          icon={<Check {...icon} />}
          aria-label={t("onboarding.setting.acceptFor", { key: rateKey })}
        >
          {t("onboarding.setting.accept")}
        </Button>
      </div>
      <ManageFeedback result={result} path={ONBOARDING_PAGE} fieldIds={ids} />
    </form>
  );
}

/**
 * A kind of record's retention: keep Harbour's period, or, for records the organisation's policy
 * sets, say it does not keep them. The API says which a kind of record takes.
 */
export function RetentionDecision({ recordClass }: { readonly recordClass: string }) {
  const { result, pending, send } = useDecision();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={pending}
          icon={<Check {...icon} />}
          aria-label={t("onboarding.retention.keepFor", { recordClass })}
          onClick={() => send(() => decideRetention(recordClass, "accepted"))}
        >
          {t("onboarding.retention.keep")}
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          icon={<Ban {...icon} />}
          aria-label={t("onboarding.retention.notUsedFor", { recordClass })}
          onClick={() => send(() => decideRetention(recordClass, "not_used"))}
        >
          {t("onboarding.retention.notUsed")}
        </Button>
      </div>
      <ManageFeedback result={result} path={ONBOARDING_PAGE} />
    </div>
  );
}

/** One option for all staff files, chosen against the organisation record as read. */
export function StaffFileOption({
  current,
  version,
}: {
  readonly current: string | null;
  readonly version: number;
}) {
  const { result, pending, send } = useDecision();
  const [option, setOption] = useState<(typeof STAFF_FILE_OPTIONS)[number] | null>(
    STAFF_FILE_OPTIONS.find((o) => o === current) ?? null,
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (option) send(() => chooseStaffFileOption(option, version));
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <RadioGroup
        legend={t("onboarding.staffFile.legend")}
        name="staffFileOption"
        value={option}
        onValueChange={setOption}
        options={STAFF_FILE_OPTIONS.map((value) => ({
          value,
          label: t("onboarding.staffFile.option", { option: value.replace("staff_file.", "") }),
        }))}
      />
      <div>
        <Button type="submit" disabled={pending || !option} icon={<Save {...icon} />}>
          {t("onboarding.staffFile.save")}
        </Button>
      </div>
      <ManageFeedback result={result} path={ONBOARDING_PAGE} />
    </form>
  );
}

/**
 * Records that the CSO or clinical lead assessed the deployment against this safety case, naming
 * who made the assessment before it is sent.
 */
export function RecordDcb0160({
  safetyCaseVersion,
  reviewers,
}: {
  readonly safetyCaseVersion: string;
  readonly reviewers: readonly Reviewer[];
}) {
  const { result, setResult, pending, send } = useDecision();
  const ids = useFieldIds(["reviewer"] as const);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const assessor = String(new FormData(event.currentTarget).get("reviewer") ?? "");
    if (!assessor) {
      setResult(fieldErrors({ reviewer: t("onboarding.reviewer.assessorRequired") }));
      return;
    }
    send(() => recordDcb0160(safetyCaseVersion, assessor));
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
      <p className="m-0">{t("onboarding.dcb0160.about", { version: safetyCaseVersion })}</p>
      <ReviewerField
        id={ids.reviewer}
        label={t("onboarding.reviewer.dcb0160")}
        reviewers={reviewers}
        result={result}
      />
      <div>
        <Button type="submit" disabled={pending} icon={<FileCheck {...icon} />}>
          {t("onboarding.dcb0160.record", { version: safetyCaseVersion })}
        </Button>
      </div>
      <ManageFeedback result={result} path={ONBOARDING_PAGE} fieldIds={ids} />
    </form>
  );
}
