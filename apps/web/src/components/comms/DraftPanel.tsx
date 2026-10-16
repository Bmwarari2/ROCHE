"use client";

import { Button } from "@harbour/ui";
import { PencilLine } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApproveVersion, type VersionRef } from "@/components/comms/TemplateActions";
import { TemplateForm } from "@/components/comms/TemplateForm";
import { t } from "@/lib/i18n";
import type { TemplateChannel } from "@/lib/letters";

/**
 * A draft's words and what can be done with them (comms.md rules 22 and 23; HZ-051). An approver
 * sees the stored words read-only beside Approve, so nothing approved differs from what is on
 * screen; one who may also write opens the form with "Edit draft", and Approve is not offered
 * while it is open. A writer who cannot approve sees the form straight away. The form is keyed on
 * the draft's version, so after anyone's save it shows the words now stored, never older ones.
 */
export function DraftPanel({
  path,
  target,
  channel,
  words,
  issues,
  canEdit,
  canApprove,
  readOnly,
}: {
  readonly path: string;
  readonly target: VersionRef;
  readonly channel: TemplateChannel;
  readonly words: { readonly name: string; readonly subject: string | null; readonly body: string };
  readonly issues: readonly { readonly problem: string; readonly message: string }[];
  readonly canEdit: boolean;
  readonly canApprove: boolean;
  /** The stored words and their problems, drawn on the server. */
  readonly readOnly: ReactNode;
}) {
  const [editing, setEditing] = useState(canEdit && !canApprove);
  const editButton = useRef<HTMLButtonElement>(null);
  const reopened = useRef(false);
  // Closing the form puts focus back on the button that opened it (WCAG 2.4.3).
  useEffect(() => {
    if (!editing && reopened.current) editButton.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <TemplateForm
        key={`${target.versionId}:${target.version}`}
        path={path}
        mode={{
          kind: "edit",
          templateId: target.templateId,
          versionId: target.versionId,
          version: target.version,
          channel,
          words,
          issues,
          ...(canApprove
            ? {
                onCancel: () => {
                  reopened.current = true;
                  setEditing(false);
                },
              }
            : {}),
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {readOnly}
      <div className="flex flex-wrap gap-2">
        {canEdit ? (
          <Button
            ref={editButton}
            variant="secondary"
            icon={<PencilLine size={20} strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => setEditing(true)}
          >
            {t("comms.templates.editDraft")}
          </Button>
        ) : null}
      </div>
      {canApprove ? <ApproveVersion path={path} target={target} /> : null}
    </div>
  );
}
