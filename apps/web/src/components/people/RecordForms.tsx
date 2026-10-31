"use client";

import { Button, TextArea } from "@harbour/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor, type FieldErrors, fieldErrors } from "@/lib/outcome";

/**
 * Shared pieces of the personal details, About me and sharing forms (PEOP-001, PEOP-003 and
 * PEOP-013). A form sends its change and, once it is saved, opens the page again with `done`,
 * which says what was done and takes focus there (TemplateArrival). A refusal stays on the form
 * as a summary that takes focus and links to each field; a step that needs a fresh sign-in shows
 * the step-up notice with the way back to this page.
 */

/** The longest reason the API takes for a suspension, withdrawal or revocation. */
export const REASON_MAX = 1000;

export function useRecordSend(path: string) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  /**
   * Sends one change. On success the page opens again at `done`, unless `stay` says to keep this
   * form on the page (a share link's code, which is shown only once).
   */
  const send = <T,>(
    done: string,
    call: () => Promise<ActionResult<T>>,
    stay?: (data: T) => boolean,
  ) =>
    startTransition(async () => {
      const outcome = await call();
      setResult(outcome);
      if (!outcome.ok) return;
      if (stay?.(outcome.data)) {
        router.refresh();
        return;
      }
      // `at` makes each save a new arrival, so a second identical save is said and focused again.
      router.replace(`${path}?done=${done}&at=${Date.now()}`, { scroll: false });
    });
  /** Problems the form found before sending, each at its field. */
  const fail = (errors: FieldErrors) => setResult(fieldErrors(errors));
  return { result, setResult, pending, send, fail };
}

/**
 * A button that opens a short form asking for a reason, then does one thing: suspend, lift or
 * withdraw a sharing decision, or revoke a share link. The form says what will happen before
 * anything is sent (CONTENT.md rule 4). Opening it moves focus to the reason; Cancel puts focus
 * back on the button.
 */
export function ReasonAction({
  open,
  label,
  hint,
  consequence,
  submit,
  path,
  done,
  destructive = false,
  onSend,
}: {
  /** The button that opens the form, naming the action and the thing. */
  readonly open: string;
  readonly label: string;
  readonly hint?: string;
  readonly consequence: string;
  readonly submit: string;
  readonly path: string;
  readonly done: string;
  readonly destructive?: boolean;
  readonly onSend: (reason: string) => Promise<ActionResult<unknown>>;
}) {
  const inline = useInlineForm<HTMLTextAreaElement>();
  const ids = useFieldIds(["reason"]);
  const { result, setResult, pending, send, fail } = useRecordSend(path);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (reason.length < 3 || reason.length > REASON_MAX) {
      fail({ reason: t("people.sharing.reasonError") });
      return;
    }
    send(done, () => onSend(reason));
  };
  const reasonError = errorFor(result, "reason");

  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
          <p className="m-0 max-w-prose font-semibold">{consequence}</p>
          <TextArea
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={label}
            rows={2}
            required
            maxLength={REASON_MAX}
            formatCount={(remaining) => characterCount(remaining)}
            {...(hint ? { hint } : {})}
            {...(reasonError ? { error: reasonError } : {})}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant={destructive ? "destructive" : "primary"}
              disabled={pending}
            >
              {pending ? t("common.saving") : submit}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                inline.hide();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            ref={inline.trigger}
            variant="secondary"
            onClick={() => {
              setResult(null);
              inline.show();
            }}
          >
            {open}
          </Button>
        </div>
      )}
      <ManageFeedback result={result} path={path} fieldIds={ids} />
    </div>
  );
}

/**
 * A form that opens in place from a button and closes again with Cancel (focus goes back to the
 * button). The children render the form; `close` hides it.
 */
export function InlineSection({
  open,
  children,
}: {
  readonly open: string;
  readonly children: (close: () => void) => ReactNode;
}) {
  const inline = useInlineForm<HTMLDivElement>();
  return inline.open ? (
    <div ref={inline.firstField} tabIndex={-1} className="flex flex-col gap-4">
      {children(inline.hide)}
    </div>
  ) : (
    <div>
      <Button ref={inline.trigger} variant="secondary" onClick={inline.show}>
        {open}
      </Button>
    </div>
  );
}
