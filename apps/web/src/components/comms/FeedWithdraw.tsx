"use client";

import { Button, SelectField } from "@harbour/ui";
import { Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { withdrawFeedItem } from "@/app/actions/family-feed";
import { useFieldIds } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { FEED_WITHDRAWAL_REASONS, type FeedWithdrawalReason } from "@/lib/family-feed";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";

/**
 * Taking one update down, with a reason (comms.md section 5; `comms.feed.withdraw`). The family
 * member who saw it is told only that an update was taken down, never why or what it said.
 */
export function FeedWithdraw({
  personId,
  itemId,
  path,
  label,
}: {
  readonly personId: string;
  readonly itemId: string;
  readonly path: string;
  /** Names the update, so each form's controls are told apart: "Take down: Addie enjoyed ...". */
  readonly label: string;
}) {
  const router = useRouter();
  const ids = useFieldIds(["reason"]);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    if (!(FEED_WITHDRAWAL_REASONS as readonly string[]).includes(reason)) {
      setResult(refused(t("comms.feed.withdraw.reasonError"), "invalid", ["reason"]));
      return;
    }
    startTransition(async () => {
      const outcome = await withdrawFeedItem(personId, itemId, reason as FeedWithdrawalReason);
      setResult(outcome.ok ? null : outcome);
      if (outcome.ok) router.replace(`${path}?done=withdrawn&at=${Date.now()}`, { scroll: false });
    });
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={onSubmit}
      noValidate
      aria-label={t("comms.feed.withdraw.formLabel", { label })}
    >
      <SelectField
        id={ids.reason}
        name="reason"
        label={t("comms.feed.withdraw.reason")}
        emptyOption={t("comms.feed.withdraw.chooseReason")}
        required
        error={errorFor(result, "reason")}
        options={FEED_WITHDRAWAL_REASONS.map((reason) => ({
          value: reason,
          label: t("comms.feed.withdraw.reasonOption", { reason }),
        }))}
      />
      <div>
        <Button
          type="submit"
          variant="secondary"
          icon={<Undo2 size={20} strokeWidth={1.5} aria-hidden="true" />}
          disabled={pending}
        >
          {t("comms.feed.withdraw.submit")}
        </Button>
      </div>
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </form>
  );
}
