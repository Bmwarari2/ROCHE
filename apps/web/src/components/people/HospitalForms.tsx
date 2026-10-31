"use client";

import { Button, Checkbox, TextArea, TextField } from "@harbour/ui";
import { CircleCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState, useTransition } from "react";
import {
  completeReturnCheck,
  recordHandover,
  recordReturn,
  sendToHospital,
} from "@/app/actions/hospital";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useEntryId, useFieldIds } from "@/components/care/form-state";
import { WhenField } from "@/components/care/WhenField";
import { tabHref } from "@/lib/care-record";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, partsFor, partsRefusal, refused } from "@/lib/outcome";
import { MIN_INCOMPLETE_PACK_REASON_LENGTH, reasonLongEnough } from "@/lib/transfer-pack";
import { readWhen } from "@/lib/uk-time";

const SEND_FIELDS = ["hospitalName", "hospitalOdsCode", "leftAt", "reason", "items"] as const;

/**
 * Send the person to hospital with the transfer pack, in one form (people.md rule 10; PEOP-009;
 * HZ-023). Only the hospital must be typed: "Now" is the time unless changed, and the reason and
 * belongings are optional. The API makes the pack from the record as it is at that moment; the
 * transfer's own id goes with every attempt, so a send retried after a lost connection records
 * once (HZ-029). Once sent, the tab opens on the pack with the print link, and focus moves there.
 */
export function SendToHospitalForm({
  personId,
  version,
  items,
}: {
  readonly personId: string;
  /** The person record's version, as the page read it. */
  readonly version: number;
  /** Glasses, hearing aids, dentures and walking aids held at the home. */
  readonly items: readonly { readonly id: string; readonly description: string }[];
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(SEND_FIELDS);
  const entry = useEntryId();
  const itemsLegend = useId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const hospitalName = text("hospitalName").trim();
    if (!hospitalName) {
      setResult(refused(t("people.transfer.send.hospitalRequired"), "invalid", ["hospitalName"]));
      return;
    }
    const left = readWhen(form, "leftAt", t, { subject: t("people.transfer.send.when") });
    if (!left.ok) {
      setResult(partsRefusal("leftAt", left));
      return;
    }
    startTransition(async () => {
      const outcome = await sendToHospital(personId, {
        id: entry.id,
        hospitalName,
        hospitalOdsCode: text("hospitalOdsCode"),
        leftAt: left.instant,
        reason: text("reason"),
        sendItemIds: form.getAll("items").map(String),
        version,
      });
      // On success the page says so where it lands (ArrivalNotice), once.
      setResult(outcome.ok ? null : outcome);
      if (outcome.ok) {
        entry.next();
        router.push(`${tabHref(personId, "hospital")}?done=sent`, { scroll: false });
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <p className="m-0 max-w-prose">{t("people.transfer.send.hint")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id={ids.hospitalName}
            error={errorFor(result, "hospitalName")}
            name="hospitalName"
            label={t("people.transfer.send.hospital")}
            autoComplete="off"
            maxLength={200}
            required
          />
          <TextField
            id={ids.hospitalOdsCode}
            error={errorFor(result, "hospitalOdsCode")}
            name="hospitalOdsCode"
            label={t("people.transfer.send.ods")}
            autoComplete="off"
            maxLength={20}
          />
        </div>
        <WhenField
          name="leftAt"
          legend={t("people.transfer.send.when")}
          id={ids.leftAt}
          error={errorFor(result, "leftAt")}
          errorParts={partsFor(result, "leftAt")}
        />
        <TextArea
          id={ids.reason}
          error={errorFor(result, "reason")}
          name="reason"
          label={t("people.transfer.send.reason")}
          rows={3}
          maxLength={2000}
          formatCount={(remaining) => characterCount(remaining)}
        />
        {items.length > 0 ? (
          <fieldset
            id={ids.items}
            className="m-0 flex flex-col gap-2 border-0 p-0"
            aria-describedby={itemsLegend}
          >
            <legend className="mb-1 p-0 font-semibold">{t("people.transfer.send.items")}</legend>
            <p id={itemsLegend} className="m-0 text-body-dense text-text-secondary">
              {t("people.transfer.send.itemsHint")}
            </p>
            {items.map((item) => (
              <Checkbox
                key={item.id}
                name="items"
                value={item.id}
                label={item.description}
                defaultChecked
              />
            ))}
          </fieldset>
        ) : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("people.transfer.send.sending") : t("people.transfer.send.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("people.transfer.send.done")} fieldIds={ids} />
    </div>
  );
}

const HANDOVER_FIELDS = ["acknowledgementReason"] as const;

/**
 * Record that the pack went with the person (HZ-023). A pack missing a safety-critical section, or
 * with resuscitation records that disagree, still goes, but the hand-over is recorded only with the
 * name of the person handing it over (the API takes it from the session) and why.
 */
export function HandoverForm({
  personId,
  transferId,
  version,
  needsAcknowledgement,
}: {
  readonly personId: string;
  readonly transferId: string;
  readonly version: number;
  readonly needsAcknowledgement: boolean;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(HANDOVER_FIELDS);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = needsAcknowledgement
      ? String(new FormData(event.currentTarget).get("acknowledgementReason") ?? "")
      : null;
    if (reason !== null && !reasonLongEnough(reason)) {
      setResult(
        refused(
          t("people.transfer.handover.reasonRequired", { min: MIN_INCOMPLETE_PACK_REASON_LENGTH }),
          "invalid",
          ["acknowledgementReason"],
        ),
      );
      return;
    }
    startTransition(async () => {
      const outcome = await recordHandover(personId, transferId, {
        acknowledgementReason: reason,
        version,
      });
      setResult(outcome.ok ? null : outcome);
      // The form is replaced by the hand-over as recorded: the page says so and takes focus.
      if (outcome.ok) {
        router.push(`${tabHref(personId, "hospital")}?done=handover`, { scroll: false });
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {needsAcknowledgement ? (
          <>
            <p className="m-0 max-w-prose font-semibold">
              {t("people.transfer.handover.needsAck")}
            </p>
            <TextArea
              id={ids.acknowledgementReason}
              error={errorFor(result, "acknowledgementReason")}
              name="acknowledgementReason"
              label={t("people.transfer.handover.reason")}
              hint={t("people.transfer.handover.reasonHint", {
                min: MIN_INCOMPLETE_PACK_REASON_LENGTH,
              })}
              rows={3}
              maxLength={1000}
              required
              formatCount={(remaining) => characterCount(remaining)}
            />
          </>
        ) : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("people.transfer.handover.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("people.transfer.handover.saved")} fieldIds={ids} />
    </div>
  );
}

const RETURN_FIELDS = ["returnedAt"] as const;

/** Record the person's return: rounds restart and the checks on return are set (HZ-003, HZ-023). */
export function ReturnForm({
  personId,
  transferId,
  version,
}: {
  readonly personId: string;
  readonly transferId: string;
  readonly version: number;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(RETURN_FIELDS);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const back = readWhen(new FormData(event.currentTarget), "returnedAt", t, {
      subject: t("people.transfer.return.when"),
    });
    if (!back.ok) {
      setResult(partsRefusal("returnedAt", back));
      return;
    }
    startTransition(async () => {
      const outcome = await recordReturn(personId, transferId, {
        returnedAt: back.instant,
        version,
      });
      // On success the page says so where it lands (ArrivalNotice), once.
      setResult(outcome.ok ? null : outcome);
      if (outcome.ok) {
        router.push(`${tabHref(personId, "hospital")}?done=returned`, { scroll: false });
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <p className="m-0 max-w-prose">{t("people.transfer.return.hint")}</p>
        <WhenField
          name="returnedAt"
          legend={t("people.transfer.return.when")}
          id={ids.returnedAt}
          error={errorFor(result, "returnedAt")}
          errorParts={partsFor(result, "returnedAt")}
        />
        <div>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? t("common.saving") : t("people.transfer.return.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("people.transfer.return.saved")} fieldIds={ids} />
    </div>
  );
}

/**
 * Mark one check on return as done. The API decides whether this person may (the check's task
 * permission, or its assignee): a refusal says so in words.
 */
export function ReturnCheckButton({
  personId,
  transferId,
  checkKey,
  checkLabel,
  version,
}: {
  readonly personId: string;
  readonly transferId: string;
  readonly checkKey: string;
  readonly checkLabel: string;
  readonly version: number;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          icon={<CircleCheck size={16} strokeWidth={1.5} />}
          disabled={pending}
          aria-label={t("people.transfer.checks.submitFor", { check: checkLabel })}
          onClick={() =>
            startTransition(async () => {
              const outcome = await completeReturnCheck(personId, transferId, checkKey, version);
              setResult(outcome.ok ? null : outcome);
              // The button goes once the check is done: the page says so and takes focus.
              if (outcome.ok) {
                router.push(`${tabHref(personId, "hospital")}?done=check&at=${checkKey}`, {
                  scroll: false,
                });
              }
            })
          }
        >
          {t("people.transfer.checks.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("people.transfer.checks.saved")} />
    </div>
  );
}
