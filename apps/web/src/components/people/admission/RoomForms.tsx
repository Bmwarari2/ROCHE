"use client";

import { Button, SelectField, TextArea } from "@harbour/ui";
import { BedDouble, CircleCheck, CircleMinus, Undo2 } from "lucide-react";
import { type FormEvent, useEffect } from "react";
import { moveBed, updateChecklistItem } from "@/app/actions/admission";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import { type BedChoiceGroup, readBedChoice } from "@/lib/admission";
import { characterCount, t } from "@/lib/i18n";
import { collectedRefusal, errorFor, type FieldProblem } from "@/lib/outcome";
import { readDateField } from "@/lib/uk-time";
import { bedSelectGroups } from "./AdmitForm";
import { useActionForm } from "./action-form";
import { DateField } from "./DateField";

const MOVE_FIELDS = ["bed", "on", "reason"] as const;

/**
 * Move the person to another room or bed (people.md rule 6; people.admission.manage): the day of
 * the move (never in the future, never before or on the day of the current bed) and the reason.
 * A move recorded after its day is flagged as backdated in the history. The person's version is
 * sent, so a move made by someone else first is never overwritten.
 */
export function BedMoveForm({
  personId,
  version,
  beds,
  today,
}: {
  readonly personId: string;
  readonly version: number;
  readonly beds: readonly BedChoiceGroup[];
  readonly today: string;
}) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLElement>();
  const ids = useFieldIds(MOVE_FIELDS);
  useEffect(() => {
    if (inline.open) document.getElementById(ids.bed)?.focus();
  }, [inline.open, ids.bed]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const problems: FieldProblem[] = [];
    const bed = readBedChoice(data.get("bed"));
    if (!bed) problems.push({ field: "bed", message: t("people.room.move.bedRequired") });
    const on = readDateField(data, "on", { subject: t("people.room.move.dateSubject"), t });
    if (!on.ok) problems.push({ field: "on", message: on.message, parts: on.parts });
    else if (on.date && on.date > today) {
      problems.push({ field: "on", message: t("people.room.move.future") });
    }
    const reason = String(data.get("reason") ?? "");
    if (reason.trim().length < 3) {
      problems.push({ field: "reason", message: t("people.room.move.reasonRequired") });
    }
    const refusal = collectedRefusal(problems);
    if (refusal || !bed || !on.ok) {
      form.setResult(refusal);
      return;
    }
    form.run(
      () => moveBed(personId, { ...bed, on: on.date ?? "", reason, version }),
      () => inline.hide(),
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {inline.open ? (
        <form
          method="post"
          className="flex flex-col gap-4 border-s-4 border-border ps-4"
          onSubmit={submit}
          noValidate
        >
          {beds.length > 0 ? (
            <SelectField
              id={ids.bed}
              name="bed"
              label={t("people.room.move.to")}
              hint={t("people.room.move.toHint")}
              emptyOption={t("people.room.choose")}
              required
              groups={bedSelectGroups(beds)}
              error={errorFor(form.result, "bed")}
              className="max-w-md"
            />
          ) : (
            <p id={ids.bed} tabIndex={-1} className="m-0 font-semibold">
              {t("people.room.noneFree")}
            </p>
          )}
          <DateField
            id={ids.on}
            name="on"
            legend={t("people.room.move.date")}
            hint={t("people.room.move.dateHint")}
            result={form.result}
            defaultValue={today}
          />
          <TextArea
            id={ids.reason}
            name="reason"
            label={t("people.room.move.reason")}
            hint={t("people.room.move.reasonHint")}
            rows={2}
            required
            maxLength={500}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(form.result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={form.pending || beds.length === 0}>
              {form.pending ? t("common.saving") : t("people.room.move.submit")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                form.setResult(null);
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
            icon={<BedDouble size={16} strokeWidth={1.5} />}
            onClick={() => {
              form.setResult(null);
              inline.show();
            }}
          >
            {t("people.room.move.open")}
          </Button>
        </div>
      )}
      <FormFeedback result={form.result} success={t("people.room.move.saved")} fieldIds={ids} />
    </div>
  );
}

const ITEM_FIELDS = ["reason"] as const;

/**
 * Tick an item of the welcome checklist, mark it not applicable with a reason where the item
 * allows it (never a safety-critical item), or put it back to do. The item's version is sent.
 * Stays on the page after a change, so its words are heard and focus has somewhere to go.
 */
export function ChecklistItemActions({
  personId,
  itemKey,
  title,
  status,
  allowNotApplicable,
  version,
}: {
  readonly personId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly status: "pending" | "done" | "not_applicable";
  readonly allowNotApplicable: boolean;
  readonly version: number;
}) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLTextAreaElement>();
  const ids = useFieldIds(ITEM_FIELDS);
  const send = (next: "pending" | "done" | "not_applicable", reason?: string) =>
    form.run(
      () =>
        updateChecklistItem(personId, itemKey, {
          status: next,
          ...(reason !== undefined ? { reason } : {}),
          version,
        }),
      () => inline.hide(),
    );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    if (reason.trim().length < 3) {
      form.setResult(
        collectedRefusal([{ field: "reason", message: t("people.checklist.reasonRequired") }]),
      );
      return;
    }
    send("not_applicable", reason);
  };
  return (
    <div className="flex flex-col gap-2">
      {inline.open ? (
        <form method="post" className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <TextArea
            ref={inline.firstField}
            id={ids.reason}
            name="reason"
            label={t("people.checklist.reason", { title })}
            rows={2}
            required
            maxLength={500}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(form.result, "reason")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={form.pending}>
              {t("people.checklist.notApplicableSubmit")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                form.setResult(null);
                inline.hide();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status === "pending" ? (
            <>
              <Button
                variant="secondary"
                icon={<CircleCheck size={16} strokeWidth={1.5} />}
                disabled={form.pending}
                onClick={() => send("done")}
              >
                {t("people.checklist.done", { title })}
              </Button>
              {allowNotApplicable ? (
                <Button
                  ref={inline.trigger}
                  variant="secondary"
                  icon={<CircleMinus size={16} strokeWidth={1.5} />}
                  onClick={() => {
                    form.setResult(null);
                    inline.show();
                  }}
                >
                  {t("people.checklist.notApplicable", { title })}
                </Button>
              ) : null}
            </>
          ) : (
            <Button
              variant="secondary"
              icon={<Undo2 size={16} strokeWidth={1.5} />}
              disabled={form.pending}
              onClick={() => send("pending")}
            >
              {t("people.checklist.undo", { title })}
            </Button>
          )}
        </div>
      )}
      <FormFeedback
        result={form.result}
        success={t("people.checklist.saved", { title })}
        fieldIds={ids}
      />
    </div>
  );
}
