"use client";

import "./globals.css";
import { t } from "@/lib/i18n";

/** Last-resort error page when the root layout itself fails. It renders its own document. */
export default function GlobalError({ retry }: { readonly retry: () => void }) {
  return (
    <html lang={t.locale}>
      <body className="bg-bg-secondary">
        <main className="mx-auto flex min-h-dvh max-w-content flex-col items-start justify-center gap-4 p-shell">
          <h1 className="m-0 text-title">{t("errors.app.title")}</h1>
          <p className="m-0 text-body text-text-secondary">{t("errors.app.body")}</p>
          <button type="button" className="hb-button hb-button--primary" onClick={() => retry()}>
            <span className="hb-button__label">{t("common.retry")}</span>
          </button>
        </main>
      </body>
    </html>
  );
}
