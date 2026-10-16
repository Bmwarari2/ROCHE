"use client";

import { Button, Sheet, SheetClose } from "@harbour/ui";
import { FlaskConical, Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { loadSampleData, removeSampleData } from "@/app/actions/onboarding";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import { ONBOARDING_PAGE } from "@/lib/onboarding";
import type { ActionResult } from "@/lib/outcome";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Loads or removes the sample people (platform-completions.md rules 29 to 32; HZ-072), each after
 * a confirmation that says what happens. Removal needs a fresh step-up; a refusal is said in plain
 * words. The API checks everything again.
 */
function SampleAction({
  label,
  title,
  keep,
  destructive,
  buttonIcon,
  done,
  call,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly keep: string;
  readonly destructive: boolean;
  readonly buttonIcon: ReactNode;
  /** The `done` the page opens with afterwards, to say what was done. */
  readonly done: "sampleLoaded" | "sampleRemoved";
  readonly call: () => Promise<ActionResult<null>>;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult<null> | null>(null);
  const [pending, startTransition] = useTransition();
  const send = () =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (outcome.ok) {
        setOpen(false);
        router.replace(`${ONBOARDING_PAGE}?done=${done}&at=${Date.now()}`, { scroll: false });
        router.refresh();
      }
    });
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setResult(null);
      }}
      trigger={
        <Button variant={destructive ? "secondary" : "primary"} icon={buttonIcon}>
          {label}
        </Button>
      }
      title={title}
      closeLabel={t("common.close")}
    >
      <div className="flex flex-col gap-4">
        {children}
        <ManageFeedback
          result={result}
          path={ONBOARDING_PAGE}
          stepUp={t("onboarding.sample.stepUp")}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <SheetClose asChild>
            <Button variant="secondary">{keep}</Button>
          </SheetClose>
          <Button
            variant={destructive ? "destructive" : "primary"}
            icon={buttonIcon}
            disabled={pending}
            onClick={send}
          >
            {pending ? t("common.saving") : label}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** Loads the sample people: offered only while no batch is in place and no real person exists. */
export function LoadSampleData({ count }: { readonly count: number }) {
  return (
    <SampleAction
      label={t("onboarding.sample.load")}
      title={t("onboarding.sample.loadTitle")}
      keep={t("common.cancel")}
      destructive={false}
      buttonIcon={<FlaskConical {...icon} />}
      done="sampleLoaded"
      call={loadSampleData}
    >
      <p className="m-0">{t("onboarding.sample.loadBody", { count })}</p>
    </SampleAction>
  );
}

/** Removes the sample people and what was recorded about them while practising. */
export function RemoveSampleData() {
  return (
    <SampleAction
      label={t("onboarding.sample.remove")}
      title={t("onboarding.sample.removeTitle")}
      keep={t("onboarding.sample.keep")}
      destructive
      buttonIcon={<Trash2 {...icon} />}
      done="sampleRemoved"
      call={removeSampleData}
    >
      <div role="note" className="flex gap-3">
        <TriangleAlert {...icon} className="mt-0.5 shrink-0" />
        <p className="m-0">{t("onboarding.sample.removeBody")}</p>
      </div>
    </SampleAction>
  );
}
