"use client";

import { Button, EmptyState } from "@harbour/ui";
import { CircleAlert } from "lucide-react";
import { useEffect } from "react";
import { t } from "@/lib/i18n";

/** A page inside the shell failed; the app bar and sidebar stay so the person can move on. */
export default function ShellErrorPage({
  error,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}) {
  useEffect(() => {
    console.error("Harbour page error", error.digest ?? error.name);
  }, [error]);

  return (
    <div className="mx-auto max-w-content py-12">
      <EmptyState
        headingLevel={1}
        icon={<CircleAlert size={40} strokeWidth={1.5} aria-hidden="true" />}
        title={t("errors.page.title")}
        description={t("errors.page.body")}
        action={
          <Button variant="primary" onClick={() => retry()}>
            {t("common.retry")}
          </Button>
        }
        secondaryAction={
          error.digest ? (
            <p className="m-0 text-callout text-text-secondary">
              {t("errors.reference", { reference: error.digest })}
            </p>
          ) : null
        }
      />
    </div>
  );
}
