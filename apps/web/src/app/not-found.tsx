import { buttonClassName, EmptyState } from "@harbour/ui";
import { SearchX } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { t } from "@/lib/i18n";

export const metadata = { title: "Page not found" };

/**
 * Shown for any address Harbour does not recognise. Rendered per request, like every page, so its
 * scripts carry the CSP nonce (src/proxy.ts).
 */
export default async function NotFound() {
  await connection();
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-content items-center p-shell">
      <EmptyState
        className="w-full"
        headingLevel={1}
        icon={<SearchX size={40} strokeWidth={1.5} aria-hidden="true" />}
        title={t("errors.notFound")}
        description="The page may have moved, or the link may be out of date."
        action={
          <Link href="/" className={buttonClassName({ variant: "primary" })}>
            Go to the home page
          </Link>
        }
      />
    </main>
  );
}
