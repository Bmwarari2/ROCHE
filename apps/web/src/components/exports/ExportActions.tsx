"use client";

import { Button, buttonClassName, Sheet, SheetClose } from "@harbour/ui";
import { Ban, FileDown, PackagePlus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { cancelExport, requestExport } from "@/app/actions/exports";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { EXPORT_PAGE } from "@/lib/exports";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/** Sends an action and, once done, opens the page again saying what was done (a new `at`). */
function useExportSend() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = (done: string, call: () => Promise<ActionResult<unknown>>, after?: () => void) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        after?.();
        router.replace(`${EXPORT_PAGE}?done=${done}&at=${Date.now()}`, { scroll: false });
        router.refresh();
      }
    });
  return { result, pending, send };
}

const feedback = (result: ActionResult<unknown> | null) => (
  <ManageFeedback result={result} path={EXPORT_PAGE} stepUp={t("export.stepUp")} />
);

/** Asks for a new export (free, one at a time). */
export function RequestExport() {
  const { result, pending, send } = useExportSend();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          disabled={pending}
          icon={<PackagePlus {...icon} />}
          onClick={() => send("requested", requestExport)}
        >
          {pending ? t("common.saving") : t("export.request")}
        </Button>
      </div>
      {feedback(result)}
    </div>
  );
}

function Confirm({
  open: label,
  variant,
  buttonIcon,
  title,
  children,
  footer,
}: {
  readonly open: string;
  readonly variant: "primary" | "secondary";
  readonly buttonIcon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant={variant} icon={buttonIcon}>
          {label}
        </Button>
      }
      title={title}
      closeLabel={t("common.close")}
    >
      <div className="flex flex-col gap-4">
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{t("common.cancel")}</Button>
          </SheetClose>
          {footer(() => setOpen(false))}
        </div>
      </div>
    </Sheet>
  );
}

/**
 * Downloads the archive, once, after saying what it holds: every person's records, fetched only
 * once, so it is saved somewhere safe straight away (HZ-070).
 */
export function DownloadExport({ id }: { readonly id: string }) {
  return (
    <Confirm
      open={t("export.download.open")}
      variant="primary"
      buttonIcon={<FileDown {...icon} />}
      title={t("export.download.title")}
      footer={(close) => (
        <a
          href={`${EXPORT_PAGE}/${id}/download`}
          className={buttonClassName({ variant: "primary" })}
          onClick={close}
        >
          <FileDown {...icon} />
          {t("export.download.confirm")}
        </a>
      )}
    >
      <div role="note" className="flex gap-3">
        <TriangleAlert {...icon} className="mt-0.5 shrink-0" />
        <div className="flex flex-col gap-2">
          <p className="m-0 font-semibold">{t("export.download.once")}</p>
          <p className="m-0">{t("export.download.everyone")}</p>
        </div>
      </div>
    </Confirm>
  );
}

/** Cancels an export, after confirming; its archive is deleted. */
export function CancelExport({ id }: { readonly id: string }) {
  const { result, pending, send } = useExportSend();
  return (
    <Confirm
      open={t("export.cancel.open")}
      variant="secondary"
      buttonIcon={<Ban {...icon} />}
      title={t("export.cancel.title")}
      footer={(close) => (
        <Button disabled={pending} onClick={() => send("cancelled", () => cancelExport(id), close)}>
          {pending ? t("common.saving") : t("export.cancel.confirm")}
        </Button>
      )}
    >
      <p className="m-0">{t("export.cancel.body")}</p>
      {feedback(result)}
    </Confirm>
  );
}
