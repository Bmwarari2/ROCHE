"use client";

import { Button, EmptyState } from "@harbour/ui";
import { CircleAlert } from "lucide-react";
import { useEffect } from "react";
import { t } from "@/lib/i18n";

/**
 * Something failed while rendering. The message never shows internal details; the digest lets
 * support match the server log, which holds opaque ids only.
 */
export default function ErrorPage({
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
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-content items-center p-shell">
      <EmptyState
        className="w-full"
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
    </main>
  );
}
