"use client";

import { Button, StatusChip } from "@harbour/ui";
import { Copy } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";

/**
 * Copies the PIR figures (quality.md rule 43) and says so, politely, with an icon and a word. The
 * read-only text beside it stays for anyone whose browser will not copy for them.
 */
export function CopyFigures({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="secondary"
        icon={<Copy size={18} aria-hidden="true" />}
        onClick={copy}
      >
        {t("quality.pir.copy")}
      </Button>
      <span role="status">
        {copied ? <StatusChip status="done" label={t("quality.pir.copied")} /> : null}
      </span>
    </div>
  );
}
