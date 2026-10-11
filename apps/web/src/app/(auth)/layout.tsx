import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

/** Sign-in and organisation choice: a quiet centred column without the product shell. */
export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg-secondary">
      <header className="flex h-nav items-center border-b border-border bg-nav px-gutter">
        <span className="text-body font-semibold text-text">{t("app.name")}</span>
      </header>
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center gap-6 px-4 py-12"
      >
        {children}
      </main>
    </div>
  );
}
