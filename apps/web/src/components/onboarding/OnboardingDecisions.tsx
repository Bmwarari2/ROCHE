"use client";

import { Button, RadioGroup } from "@harbour/ui";
import { Ban, Check, FileCheck, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import {
  acceptSetting,
  chooseStaffFileOption,
  decideRetention,
  recordDcb0160,
} from "@/app/actions/onboarding";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import { ONBOARDING_PAGE, STAFF_FILE_OPTIONS } from "@/lib/onboarding";
import type { ActionResult } from "@/lib/outcome";

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
  return { result, pending, send };
}

/** Accepts a setting Harbour chose; a later change by Harbour reopens it. */
export function AcceptSetting({ rateKey }: { readonly rateKey: string }) {
  const { result, pending, send } = useDecision();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          disabled={pending}
          icon={<Check {...icon} />}
          aria-label={t("onboarding.setting.acceptFor", { key: rateKey })}
          onClick={() => send(() => acceptSetting(rateKey))}
        >
          {t("onboarding.setting.accept")}
        </Button>
      </div>
      <ManageFeedback result={result} path={ONBOARDING_PAGE} />
    </div>
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

/** Records that the CSO or clinical lead assessed the deployment against this safety case. */
export function RecordDcb0160({ safetyCaseVersion }: { readonly safetyCaseVersion: string }) {
  const { result, pending, send } = useDecision();
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0">{t("onboarding.dcb0160.about", { version: safetyCaseVersion })}</p>
      <div>
        <Button
          disabled={pending}
          icon={<FileCheck {...icon} />}
          onClick={() => send(() => recordDcb0160(safetyCaseVersion))}
        >
          {t("onboarding.dcb0160.record", { version: safetyCaseVersion })}
        </Button>
      </div>
      <ManageFeedback result={result} path={ONBOARDING_PAGE} />
    </div>
  );
}
