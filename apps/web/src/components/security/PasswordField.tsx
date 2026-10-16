"use client";

import { Button, TextField, VisuallyHidden } from "@harbour/ui";
import { Eye, EyeOff } from "lucide-react";
import { type Ref, useState } from "react";
import { t } from "@/lib/i18n";

/**
 * A new password with the rules shown before anyone types (NCSC: length, no composition rules)
 * and a show or hide button. The button names what it does, says which field it controls, and a
 * polite status says whether the password is now visible, so screen reader users hear the change.
 */
export function PasswordField({
  id,
  name,
  label,
  hint,
  error,
  ref,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly hint: string;
  readonly error?: string | undefined;
  readonly ref?: Ref<HTMLInputElement>;
}) {
  const [visible, setVisible] = useState(false);
  const [announced, setAnnounced] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <TextField
        ref={ref}
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        label={label}
        hint={hint}
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        {...(error ? { error } : {})}
      />
      <div>
        <Button
          type="button"
          variant="secondary"
          aria-controls={id}
          icon={
            visible ? <EyeOff size={18} strokeWidth={1.5} /> : <Eye size={18} strokeWidth={1.5} />
          }
          onClick={() => {
            setVisible(!visible);
            setAnnounced(visible ? t("security.password.hidden") : t("security.password.shown"));
          }}
        >
          {visible ? t("security.password.hide") : t("security.password.show")}
        </Button>
        <VisuallyHidden role="status">{announced}</VisuallyHidden>
      </div>
    </div>
  );
}
