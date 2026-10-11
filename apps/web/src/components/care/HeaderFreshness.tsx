"use client";

import { Button } from "@harbour/ui";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";
import { HEADER_FOCUS_REFRESH_AFTER_MS, HEADER_REFRESH_INTERVAL_MS } from "@/lib/care-record";
import { t } from "@/lib/i18n";

/**
 * How old the point-of-care header is, and a way to read it again (hazards HZ-002 and HZ-015).
 * The header is read on every tab; this also reads it again every couple of minutes while the page
 * is in view, and when someone comes back to the window, so a change a colleague made, such as a
 * withdrawn DNACPR or a new allergy, does not stay hidden. Reading again keeps what has been typed
 * into forms on the page.
 */
export function HeaderFreshness({
  checkedAt,
  checkedLabel,
}: {
  /** When the header was read, as an ISO instant. */
  readonly checkedAt: string;
  /** "14:05", UK time, worked out on the server so it matches the page. */
  readonly checkedLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const lastRead = useRef(Date.parse(checkedAt));
  useEffect(() => {
    lastRead.current = Date.parse(checkedAt);
  }, [checkedAt]);

  const readAgain = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    const whenVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRead.current >= HEADER_FOCUS_REFRESH_AFTER_MS) readAgain();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") readAgain();
    }, HEADER_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", whenVisible);
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", whenVisible);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [readAgain]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="m-0 text-body-dense text-text-secondary" data-header-checked={checkedAt}>
        <time dateTime={checkedAt}>{t("care.header.checked", { time: checkedLabel })}</time>
      </p>
      <Button
        variant="secondary"
        icon={<RefreshCw size={16} strokeWidth={1.5} />}
        onClick={readAgain}
        aria-busy={pending || undefined}
      >
        {pending ? t("care.header.checking") : t("care.header.checkAgain")}
      </Button>
    </div>
  );
}
