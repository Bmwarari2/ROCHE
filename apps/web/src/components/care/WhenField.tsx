import { TextField } from "@harbour/ui";
import { t } from "@/lib/i18n";

/**
 * When an entry happened, in UK time, defaulting to now (the server's clock when the page was
 * drawn). Changing it to an earlier time is how a late entry is written; the API flags it.
 */
export function WhenField({
  defaultValue,
  name = "occurredAt",
  label = t("care.entry.when"),
  hint = t("care.entry.whenHint"),
  error,
}: {
  readonly defaultValue: string;
  readonly name?: string;
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
}) {
  return (
    <TextField
      type="datetime-local"
      name={name}
      label={label}
      hint={hint}
      defaultValue={defaultValue}
      required
      className="max-w-xs"
      {...(error ? { error } : {})}
    />
  );
}
