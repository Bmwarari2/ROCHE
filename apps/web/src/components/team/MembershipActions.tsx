"use client";

import { Button, Checkbox, SelectField, Sheet, SheetClose } from "@harbour/ui";
import { CircleOff, Pause } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { changeMembership } from "@/app/actions/team";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";
import { membershipReasons } from "@/lib/team";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

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
}: {
  readonly kind: "suspend" | "end";
  readonly memberId: string;
  readonly name: string;
  readonly entriesWaiting: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({});
  const [pending, startTransition] = useTransition();
  // Entries the phone reported after this page was drawn: the API asks for the confirmation.
  const [lateWaiting, setLateWaiting] = useState(false);
  const path = `/settings/team/${memberId}`;
  const id = (field: string) => `membership-${kind}-${field}`;
  const askConfirm = kind === "suspend" && (entriesWaiting > 0 || lateWaiting);
  const app = t("app.name");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reasonCode = String(form.get("reasonCode") ?? "");
    const confirmed = form.get("confirmEntriesWaiting") === "on";
    const next = {
      ...(reasonCode === "" ? { reason: t("team.lifecycle.reasonRequired", { kind }) } : {}),
      ...(askConfirm && !confirmed ? { confirm: t("team.suspend.confirmRequired") } : {}),
    };
    setErrors(next);
    if (next.reason || next.confirm) {
      const first = next.reason ? id("reason") : id("confirm");
      requestAnimationFrame(() => document.getElementById(first)?.focus());
      return;
    }
    startTransition(async () => {
      const outcome = await changeMembership(
        memberId,
        kind === "suspend"
          ? { kind, reasonCode, confirmEntriesWaiting: confirmed }
          : { kind, reasonCode },
      );
      setResult(outcome);
      if (!outcome.ok && outcome.code === "entries_waiting") {
        setLateWaiting(true);
        requestAnimationFrame(() => document.getElementById(id("confirm"))?.focus());
      }
      if (outcome.ok) {
        setOpen(false);
        router.replace(
          `${path}?done=${kind === "suspend" ? "suspended" : "ended"}&at=${Date.now()}`,
          {
            scroll: false,
          },
        );
        router.refresh();
      }
    });
  };

  const label = kind === "suspend" ? t("team.suspend.open") : t("team.end.open");
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setResult(null);
          setErrors({});
          setLateWaiting(false);
        }
      }}
      trigger={
        <Button
          variant="secondary"
          icon={kind === "suspend" ? <Pause {...icon} /> : <CircleOff {...icon} />}
        >
          {label}
        </Button>
      }
      title={kind === "suspend" ? t("team.suspend.title", { name }) : t("team.end.title", { name })}
      description={kind === "suspend" ? t("team.suspend.body", { name, app }) : t("team.end.body")}
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
              {t("team.lifecycle.keep")}
            </Button>
          </SheetClose>
          <Button
            type="submit"
            variant={kind === "end" ? "destructive" : "primary"}
            disabled={pending}
          >
            {pending
              ? t("team.lifecycle.pending", { kind })
              : kind === "suspend"
                ? t("team.suspend.confirm")
                : t("team.end.confirm")}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
