"use client";

import { Button, Sheet, SheetClose } from "@harbour/ui";
import { Ban, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { resendInvitation, revokeInvitation } from "@/app/actions/team";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/** A button that asks before it acts, in a sheet that says what will happen. */
function Confirmed({
  path,
  open: openLabel,
  title,
  body,
  confirm,
  buttonIcon,
  variant,
  act,
}: {
  /** The member's page, opened again after the action and after a fresh sign-in. */
  readonly path: string;
  readonly open: string;
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  readonly buttonIcon: ReactNode;
  readonly variant: "primary" | "secondary";
  readonly act: () => Promise<ActionResult<unknown> & { readonly done?: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setResult(null);
      }}
      trigger={
        <Button variant={variant} icon={buttonIcon}>
          {openLabel}
        </Button>
      }
      title={title}
      description={body}
      closeLabel={t("common.close")}
    >
      <div className="flex flex-col gap-4">
        <ManageFeedback result={result} path={path} stepUp={t("team.stepUp.action")} />
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("common.cancel")}</Button>
          </SheetClose>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const outcome = await act();
                setResult(outcome);
                if (outcome.ok) {
                  setOpen(false);
                  // `at` makes each action a new arrival, so sending again twice is said twice.
                  router.replace(`${path}?done=${outcome.done ?? ""}&at=${Date.now()}`, {
                    scroll: false,
                  });
                  router.refresh();
                }
              })
            }
          >
            {pending ? t("common.saving") : confirm}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** Sends a new invitation; the one sent before stops working. Offered only to invited members. */
export function ResendInvitation({
  memberId,
  name,
  again,
}: {
  readonly memberId: string;
  readonly name: string;
  readonly again: boolean;
}) {
  return (
    <Confirmed
      path={`/settings/team/${memberId}`}
      open={again ? t("team.resend.again") : t("team.resend.first")}
      title={t("team.resend.title", { name })}
      body={t("team.resend.body", { name })}
      confirm={t("team.resend.confirm")}
      buttonIcon={<Send {...icon} />}
      variant="primary"
      act={async () => {
        const outcome = await resendInvitation(memberId);
        return outcome.ok
          ? { ...outcome, done: outcome.data.emailSent ? "sent" : "emailFailed" }
          : outcome;
      }}
    />
  );
}

/** Withdraws an open invitation: its link stops working at once. */
export function RevokeInvitation({
  memberId,
  invitationId,
}: {
  readonly memberId: string;
  readonly invitationId: string;
}) {
  return (
    <Confirmed
      path={`/settings/team/${memberId}`}
      open={t("team.revoke.open")}
      title={t("team.revoke.title")}
      body={t("team.revoke.body")}
      confirm={t("team.revoke.confirm")}
      buttonIcon={<Ban {...icon} />}
      variant="secondary"
      act={async () => {
        const outcome = await revokeInvitation(invitationId);
        return outcome.ok ? { ...outcome, done: "revoked" } : outcome;
      }}
    />
  );
}
