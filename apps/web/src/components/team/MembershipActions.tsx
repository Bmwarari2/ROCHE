"use client";

import { Button, Checkbox, SelectField, Sheet, SheetClose } from "@harbour/ui";
import { CircleOff, Pause, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { changeMembership } from "@/app/actions/team";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";
import { deviceChecks, membershipReasons } from "@/lib/team";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const DONE = { suspend: "suspended", reinstate: "reinstated", end: "ended" } as const;

/**
 * Suspend or end a membership (H-566), in a sheet that says what will happen: a coded reason, and
 * before a suspension, a confirmation of the care entries the member's phone last reported
 * waiting. The API checks the permission, step-up, reach and held entries again.
 */
export function MembershipAction({
  kind,
  memberId,
  name,
  entriesWaiting,
  devicesUsed,
}: {
  readonly kind: "suspend" | "reinstate" | "end";
  readonly memberId: string;
  readonly name: string;
  readonly entriesWaiting: number;
  /** Devices the member used for Care mode: ending asks how they were checked. */
  readonly devicesUsed: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string; check?: string }>({});
  const [pending, startTransition] = useTransition();
  // Entries the phone reported after this page was drawn: the API asks for the confirmation.
  const [lateWaiting, setLateWaiting] = useState(false);
  // Devices the API counted that this page did not: it asks how they were checked.
  const [lateDevices, setLateDevices] = useState(false);
  const path = `/settings/team/${memberId}`;
  const id = (field: string) => `membership-${kind}-${field}`;
  const askConfirm = kind === "suspend" && (entriesWaiting > 0 || lateWaiting);
  const app = t("app.name");
  const askCheck = kind === "end" && (devicesUsed > 0 || lateDevices);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reasonCode = String(form.get("reasonCode") ?? "");
    const confirmed = form.get("confirmEntriesWaiting") === "on";
    const deviceCheck = String(form.get("deviceCheck") ?? "");
    const next = {
      ...(reasonCode === "" ? { reason: t("team.lifecycle.reasonRequired", { kind }) } : {}),
      ...(askConfirm && !confirmed ? { confirm: t("team.suspend.confirmRequired") } : {}),
      ...(askCheck && deviceCheck === "" ? { check: t("team.end.deviceCheckRequired") } : {}),
    };
    setErrors(next);
    if (next.reason || next.confirm || next.check) {
      const first = next.reason ? id("reason") : next.confirm ? id("confirm") : id("check");
      requestAnimationFrame(() => document.getElementById(first)?.focus());
      return;
    }
    startTransition(async () => {
      const outcome = await changeMembership(
        memberId,
        kind === "suspend"
          ? { kind, reasonCode, confirmEntriesWaiting: confirmed }
          : kind === "reinstate"
            ? { kind, reasonCode }
            : { kind, reasonCode, ...(askCheck ? { deviceCheck } : {}) },
      );
      setResult(outcome);
      // The refusal's alert takes focus and says what to do; the field it names appears below it.
      if (!outcome.ok && outcome.code === "entries_waiting") setLateWaiting(true);
      if (!outcome.ok && outcome.code === "devices_unchecked") setLateDevices(true);
      if (outcome.ok) {
        setOpen(false);
        router.replace(`${path}?done=${DONE[kind]}&at=${Date.now()}`, {
          scroll: false,
        });
        router.refresh();
      }
    });
  };

  const label = t(`team.${kind}.open`);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setResult(null);
          setErrors({});
          setLateWaiting(false);
          setLateDevices(false);
        }
      }}
      trigger={
        <Button
          variant="secondary"
          icon={
            kind === "suspend" ? (
              <Pause {...icon} />
            ) : kind === "reinstate" ? (
              <Undo2 {...icon} />
            ) : (
              <CircleOff {...icon} />
            )
          }
        >
          {label}
        </Button>
      }
      title={t(`team.${kind}.title`, { name })}
      description={t(`team.${kind}.body`, { name, app })}
      closeLabel={t("common.close")}
    >
      <form
        method="post"
        className="flex flex-col gap-4"
        onSubmit={submit}
        noValidate
        aria-busy={pending}
      >
        <ManageFeedback result={result} path={path} stepUp={t("team.stepUp.membership", { app })} />
        <SelectField
          id={id("reason")}
          name="reasonCode"
          label={t("team.lifecycle.reason")}
          emptyOption={t("team.lifecycle.reasonEmpty")}
          required
          options={membershipReasons(kind, t)}
          {...(errors.reason ? { error: errors.reason } : {})}
        />
        {askCheck ? (
          <SelectField
            id={id("check")}
            name="deviceCheck"
            label={t("team.end.deviceCheck")}
            hint={t("team.end.deviceCheckHint")}
            emptyOption={t("team.end.deviceCheckEmpty")}
            required
            options={deviceChecks(t)}
            {...(errors.check ? { error: errors.check } : {})}
          />
        ) : null}
        {askConfirm ? (
          <Checkbox
            id={id("confirm")}
            name="confirmEntriesWaiting"
            label={
              entriesWaiting > 0
                ? t("team.suspend.confirmWaiting", { count: entriesWaiting })
                : t("team.suspend.confirmWaitingLate")
            }
            hint={t("team.suspend.confirmWaitingHint")}
            {...(errors.confirm ? { error: errors.confirm } : {})}
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button type="button" variant="secondary">
              {t("team.lifecycle.keep", { kind })}
            </Button>
          </SheetClose>
          <Button
            type="submit"
            variant={kind === "end" ? "destructive" : "primary"}
            disabled={pending}
          >
            {pending ? t("team.lifecycle.pending", { kind }) : t(`team.${kind}.confirm`)}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
