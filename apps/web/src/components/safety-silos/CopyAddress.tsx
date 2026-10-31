"use client";

import { Button } from "@harbour/ui";
import { Copy } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";

/** The anonymous page's full address, with a button to copy it, and the result said in words. */
export function CopyAddress({ address }: { readonly address: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = () => {
    if (!navigator.clipboard) return setCopied(false);
    navigator.clipboard.writeText(address).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 break-all font-mono">{address}</p>
      <div>
        <Button
          type="button"
          variant="secondary"
          icon={<Copy size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={copy}
        >
          {t("speakUp.anonymous.copy")}
        </Button>
      </div>
      <p role="status" className="m-0 text-body-dense">
        {copied === null
          ? ""
          : copied
            ? t("speakUp.anonymous.copied")
            : t("speakUp.anonymous.copyFailed")}
      </p>
    </div>
  );
}
