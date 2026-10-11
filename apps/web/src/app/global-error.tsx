"use client";

import "./globals.css";

/** Last-resort error page when the root layout itself fails. It renders its own document. */
export default function GlobalError({ retry }: { readonly retry: () => void }) {
  return (
    <html lang="en-GB">
      <body className="bg-bg-secondary">
        <main className="mx-auto flex min-h-dvh max-w-content flex-col items-start justify-center gap-4 p-shell">
          <h1 className="m-0 text-title">Sorry, Harbour could not be shown</h1>
          <p className="m-0 text-body text-text-secondary">
            Something went wrong on our side. Your work has not been lost. Try again in a moment.
          </p>
          <button type="button" className="hb-button hb-button--primary" onClick={() => retry()}>
            <span className="hb-button__label">Try again</span>
          </button>
        </main>
      </body>
    </html>
  );
}
