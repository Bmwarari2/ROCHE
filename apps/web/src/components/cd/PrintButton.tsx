"use client";

import { Button } from "@harbour/ui";
import { Printer } from "lucide-react";
import { t } from "@/lib/i18n";

/** Opens the browser's print dialogue; not printed itself. */
export function PrintButton() {
  return (
    <Button
      type="button"
      icon={<Printer size={18} strokeWidth={1.5} aria-hidden="true" />}
      onClick={() => window.print()}
      className="print:hidden"
    >
      {t("cd.print.button")}
    </Button>
  );
}
