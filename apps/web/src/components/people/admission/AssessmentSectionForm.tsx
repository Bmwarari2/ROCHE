"use client";

import { Button, Checkbox, RadioGroup, TextArea, TextField } from "@harbour/ui";
import { PencilLine, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { saveAssessmentSection } from "@/app/actions/admission";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds, useInlineForm } from "@/components/care/form-state";
import {
  MAX_MEDICINES,
  type MedicineRow,
  NOT_APPLICABLE_REASON_MAX,
  readMedicineRows,
  SECTION_NOTES_MAX,
} from "@/lib/admission";
import { characterCount, t } from "@/lib/i18n";
import { errorFor, fieldErrors } from "@/lib/outcome";
import { useActionForm } from "./action-form";

type Status = "complete" | "in_progress" | "not_applicable";

const FIELDS = ["status", "notes", "notApplicableReason", "medicines"] as const;

interface Row extends MedicineRow {
  readonly key: number;
}

/**
 * Edit one section of the pre-admission assessment (people.md rule 4): done, still being found
 * out, or, only where the section allows it, not applicable with a reason. A safety fact
 * (allergies, resuscitation, IDDSI levels) can never be marked not applicable (HZ-007, HZ-015,
 * HZ-016): the choice is not offered and the API refuses it. The medicines section carries the
 * list the hospital transfer pack prints until the eMAR. Saved with the assessment's version.
 */
export function AssessmentSectionForm({
  personId,
  version,
  sectionKey,
  title,
  allowNotApplicable,
  safetyFact,
  initial,
}: {
  readonly personId: string;
  readonly version: number;
  readonly sectionKey: string;
  readonly title: string;
  readonly allowNotApplicable: boolean;
  readonly safetyFact: boolean;
  readonly initial: {
    readonly status: Status | null;
    readonly notes: string | null;
    readonly notApplicableReason: string | null;
    readonly medicines: readonly MedicineRow[] | null;
  };
}) {
  const form = useActionForm();
  const inline = useInlineForm<HTMLElement>();
  const ids = useFieldIds(FIELDS);
  const isMedicines = sectionKey === "medicines";
  const [status, setStatus] = useState<Status | null>(initial.status);
  const nextKey = useRef(0);
  const toRows = (list: readonly MedicineRow[] | null): Row[] =>
    (list ?? []).map((m) => ({ ...m, key: nextKey.current++ }));
  const [rows, setRows] = useState<Row[]>(() => toRows(initial.medicines));

  const update = (key: number, change: Partial<MedicineRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!status) {
      form.setResult(fieldErrors({ status: t("people.preAdmission.section.statusRequired") }));
      return;
    }
    const read = readMedicineRows(rows);
    if (isMedicines && read.incomplete.length > 0) {
      form.setResult(
        fieldErrors({
          medicines: t("people.preAdmission.medicines.incomplete", {
            rows: read.incomplete.join(", "),
          }),
        }),
      );
      return;
    }
    form.run(
      () =>
        saveAssessmentSection(personId, version, sectionKey, {
          status,
          notes: String(data.get("notes") ?? ""),
          notApplicableReason: String(data.get("notApplicableReason") ?? ""),
          ...(isMedicines ? { medicines: read.medicines } : {}),
        }),
      () => inline.hide(),
    );
  };

  const statuses: Status[] = allowNotApplicable
    ? ["complete", "in_progress", "not_applicable"]
    : ["complete", "in_progress"];

  return (
    <div className="flex flex-col gap-3">
      {inline.open ? (
        <form
          method="post"
          className="flex flex-col gap-4 border-s-4 border-border ps-4"
          onSubmit={submit}
          noValidate
          aria-label={t("people.preAdmission.section.editLabel", { title })}
        >
          <RadioGroup<Status>
            id={ids.status}
            name="status"
            legend={t("people.preAdmission.section.statusLegend")}
            hint={safetyFact ? t("people.preAdmission.section.safetyHint") : undefined}
            layout="inline"
            value={status}
            onValueChange={setStatus}
            error={errorFor(form.result, "status")}
            options={statuses.map((value) => ({
              value,
              label: t("people.preAdmission.section.statusOption", { status: value }),
            }))}
          />
          {isMedicines ? (
            <fieldset
              id={ids.medicines}
              className="m-0 flex flex-col gap-3 border-0 p-0"
              aria-describedby={
                errorFor(form.result, "medicines") ? `${ids.medicines}-error` : undefined
              }
              tabIndex={-1}
            >
              <legend className="font-semibold">{t("people.preAdmission.medicines.legend")}</legend>
              <p className="m-0 text-text-secondary">{t("people.preAdmission.medicines.hint")}</p>
              {errorFor(form.result, "medicines") ? (
                <p id={`${ids.medicines}-error`} className="hb-field__error m-0">
                  {errorFor(form.result, "medicines")}
                </p>
              ) : null}
              {rows.map((row, index) => (
                <fieldset
                  key={row.key}
                  className="m-0 grid grid-cols-1 gap-3 rounded-input border border-border p-3 sm:grid-cols-2"
                >
                  <legend className="px-1 text-body-dense font-semibold">
                    {t("people.preAdmission.medicines.row", { n: index + 1 })}
                  </legend>
                  <TextField
                    label={t("people.preAdmission.medicines.name")}
                    value={row.name}
                    maxLength={200}
                    onChange={(e) => update(row.key, { name: e.target.value })}
                  />
                  <TextField
                    label={t("people.preAdmission.medicines.dose")}
                    value={row.dose}
                    maxLength={120}
                    onChange={(e) => update(row.key, { dose: e.target.value })}
                  />
                  <TextField
                    label={t("people.preAdmission.medicines.route")}
                    value={row.route}
                    maxLength={60}
                    onChange={(e) => update(row.key, { route: e.target.value })}
                  />
                  <TextField
                    label={t("people.preAdmission.medicines.frequency")}
                    value={row.frequency}
                    maxLength={120}
                    onChange={(e) => update(row.key, { frequency: e.target.value })}
                  />
                  <Checkbox
                    label={t("people.preAdmission.medicines.timeCritical")}
                    checked={row.timeCritical}
                    onChange={(e) => update(row.key, { timeCritical: e.target.checked })}
                  />
                  <div>
                    <Button
                      variant="secondary"
                      icon={<Trash2 size={16} strokeWidth={1.5} />}
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                    >
                      {t("people.preAdmission.medicines.remove", { n: index + 1 })}
                    </Button>
                  </div>
                </fieldset>
              ))}
              {rows.length < MAX_MEDICINES ? (
                <div>
                  <Button
                    variant="secondary"
                    icon={<Plus size={16} strokeWidth={1.5} />}
                    onClick={() =>
                      setRows((current) => [
                        ...current,
                        {
                          key: nextKey.current++,
                          name: "",
                          dose: "",
                          route: "",
                          frequency: "",
                          timeCritical: false,
                        },
                      ])
                    }
                  >
                    {t("people.preAdmission.medicines.add")}
                  </Button>
                </div>
              ) : null}
            </fieldset>
          ) : null}
          <TextArea
            id={ids.notes}
            name="notes"
            label={t("people.preAdmission.section.notes")}
            hint={
              isMedicines
                ? t("people.preAdmission.medicines.notesHint")
                : t("people.preAdmission.section.notesHint")
            }
            defaultValue={initial.notes ?? ""}
            rows={4}
            maxLength={SECTION_NOTES_MAX}
            formatCount={(remaining) => characterCount(remaining)}
            error={errorFor(form.result, "notes")}
          />
          {status === "not_applicable" ? (
            <TextArea
              id={ids.notApplicableReason}
              name="notApplicableReason"
              label={t("people.preAdmission.section.reason")}
              defaultValue={initial.notApplicableReason ?? ""}
              rows={2}
              required
              maxLength={NOT_APPLICABLE_REASON_MAX}
              formatCount={(remaining) => characterCount(remaining)}
              error={errorFor(form.result, "notApplicableReason")}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={form.pending}>
              {form.pending ? t("common.saving") : t("people.preAdmission.section.save")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                form.setResult(null);
                setStatus(initial.status);
                setRows(toRows(initial.medicines));
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
            icon={<PencilLine size={16} strokeWidth={1.5} />}
            onClick={() => {
              form.setResult(null);
              inline.show();
              // The first choice takes focus once the form is drawn.
              requestAnimationFrame(() => document.getElementById(ids.status)?.focus());
            }}
          >
            {t("people.preAdmission.section.edit", { title })}
          </Button>
        </div>
      )}
      <FormFeedback
        result={form.result}
        success={t("people.preAdmission.section.saved", { title })}
        fieldIds={ids}
      />
    </div>
  );
}
