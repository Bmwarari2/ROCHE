"use client";

import { Button, EmptyState } from "@harbour/ui";
import { CircleAlert } from "lucide-react";
import { useEffect } from "react";

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
        title="Sorry, this page could not be shown"
        description="Something went wrong on our side, or Harbour could not reach the server. Your work has not been lost. Try again in a moment."
        action={
          <Button variant="primary" onClick={() => retry()}>
            Try again
          </Button>
        }
        secondaryAction={
          error.digest ? (
            <p className="m-0 text-callout text-text-secondary">Reference: {error.digest}</p>
          ) : null
        }
      />
    </main>
  );
}
