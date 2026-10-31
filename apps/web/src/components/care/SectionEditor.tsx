"use client";

import type { CarePlanSectionItem, PcspDomain } from "@harbour/contracts";
import { Button, Checkbox, SelectField, StatusChip, TextArea, TextField } from "@harbour/ui";
import { CircleCheck, CircleMinus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import {
  addCarePlanAction,
  removeCarePlanAction,
  saveCarePlanSection,
} from "@/app/actions/care-plan";
import { ACTION_ROLES, roleLabel } from "@/lib/care-plan";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor } from "@/lib/outcome";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds } from "./form-state";

const TEXT_MAX = 4000;

const SECTION_FIELDS = ["need", "outcome", "strengths", "contingency"] as const;
const ACTION_FIELDS = ["action", "roleKey", "whenText"] as const;

/**
 * "Remove action: Help Ada to stand", then a question with "Yes, remove it" and "Keep the action",
 * so an action is never removed by one slip of the finger. Focus moves to the question and back to
 * the button when the action is kept.
 */
function RemoveAction({
  title,
  disabled,
  onRemove,
}: {
  readonly title: string;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const question = useRef<HTMLParagraphElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (asking) question.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      button.current?.focus();
    }
  }, [asking]);
  if (!asking) {
    return (
      <Button
        ref={button}
        variant="secondary"
        icon={<Trash2 size={16} strokeWidth={1.5} />}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        {t("care.plan.edit.removeAction", { action: title })}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p ref={question} tabIndex={-1} className="m-0 font-semibold">
        {t("care.plan.edit.removeConfirm")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" disabled={disabled} onClick={onRemove}>
          {t("care.plan.edit.removeYes")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            returnFocus.current = true;
            setAsking(false);
          }}
        >
          {t("care.plan.edit.removeNo")}
        </Button>
      </div>
    </div>
  );
}

/**
 * One need domain of a draft care plan: the need, the outcome in the person's words, strengths and
 * what to do if things change, then the actions staff take. Only a draft can be edited; the API
 * refuses changes to a plan in use.
 */
export function SectionEditor({
  personId,
  planId,
  domain,
  section,
  name,
}: {
  readonly personId: string;
  readonly planId: string;
  readonly domain: PcspDomain;
  readonly section: CarePlanSectionItem | null;
  readonly name: string;
}) {
  const [saved, setSaved] = useState<ActionResult<unknown> | null>(null);
  const [added, setAdded] = useState<ActionResult<unknown> | null>(null);
  const [addedMessage, setAddedMessage] = useState(t("care.plan.edit.actionAdded"));
  // The new action's client id, kept across retries of the same save (HZ-029).
  const actionEntry = useEntryId();
  const [addRound, setAddRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const sectionIds = useFieldIds(SECTION_FIELDS);
  const actionIds = useFieldIds(ACTION_FIELDS);
  const domainName = t("care.plan.domain", { domain });
  const written = Boolean(section?.need?.trim() || section?.outcome?.trim());

  const saveSection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      setSaved(
        await saveCarePlanSection(personId, planId, domain, {
          need: String(form.get("need") ?? ""),
          outcome: String(form.get("outcome") ?? ""),
          strengths: String(form.get("strengths") ?? ""),
          contingency: String(form.get("contingency") ?? ""),
          version: section?.version ?? 0,
        }),
      );
    });
  };

  const addAction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const outcome = await addCarePlanAction(personId, planId, domain, {
        id: actionEntry.id,
        action: String(form.get("action") ?? ""),
        roleKey: String(form.get("roleKey") ?? ""),
        whenText: String(form.get("whenText") ?? ""),
        evidenceRequired: form.get("evidenceRequired") === "on",
      });
      setAddedMessage(t("care.plan.edit.actionAdded"));
      setAdded(outcome);
      if (outcome.ok) {
        setAddRound((n) => n + 1);
        actionEntry.next();
      }
    });
  };

  const removeAction = (actionId: string, version: number) => {
    startTransition(async () => {
      const outcome = await removeCarePlanAction(personId, planId, actionId, version);
      setAddedMessage(t("care.plan.edit.actionRemoved"));
      setAdded(outcome);
    });
  };

  return (
    <details className="rounded-input border border-border" open={written}>
      <summary className="flex min-h-target cursor-pointer flex-wrap items-center gap-3 px-4 py-2">
        <span className="font-semibold">{domainName}</span>
        {written ? (
          <StatusChip status="done" label={t("care.plan.edit.writtenChip")} icon={CircleCheck} />
        ) : (
          <StatusChip
            status="neutral"
            label={t("care.plan.section.notWritten")}
            icon={CircleMinus}
          />
        )}
      </summary>
      <div className="flex flex-col gap-6 border-t border-border p-4">
        <form method="post" className="flex flex-col gap-4" onSubmit={saveSection} noValidate>
          <TextArea
            id={sectionIds.need}
            name="need"
            label={t("care.plan.section.need")}
            defaultValue={section?.need ?? ""}
            rows={3}
            maxLength={TEXT_MAX}
            formatCount={(remaining) => characterCount(remaining)}
          />
          <TextArea
            id={sectionIds.outcome}
            name="outcome"
            label={t("care.plan.section.outcome", { name })}
            hint={t("care.plan.edit.outcomeHint", { name })}
            defaultValue={section?.outcome ?? ""}
            rows={3}
            maxLength={TEXT_MAX}
            formatCount={(remaining) => characterCount(remaining)}
          />
          <TextArea
            id={sectionIds.strengths}
            name="strengths"
            label={t("care.plan.section.strengths")}
            defaultValue={section?.strengths ?? ""}
            rows={2}
            maxLength={TEXT_MAX}
            formatCount={(remaining) => characterCount(remaining)}
          />
          <TextArea
            id={sectionIds.contingency}
            name="contingency"
            label={t("care.plan.section.contingency")}
            defaultValue={section?.contingency ?? ""}
            rows={2}
            maxLength={TEXT_MAX}
            formatCount={(remaining) => characterCount(remaining)}
          />
          <div>
            <Button type="submit" disabled={pending}>
              {t("care.plan.edit.saveSection", { domain: domainName })}
            </Button>
          </div>
          <FormFeedback
            result={saved}
            success={t("care.plan.edit.sectionSaved")}
            fieldIds={sectionIds}
          />
        </form>

        <section className="flex flex-col gap-3" aria-label={t("care.plan.section.actions")}>
          <p className="m-0 font-semibold">{t("care.plan.section.actions")}</p>
          {section && section.actions.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {section.actions.map((action) => {
                const role = roleLabel(action.roleKey, t);
                return (
                  <li
                    key={action.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-input border border-border px-4 py-2"
                  >
                    <div className="min-w-0">
                      <p className="m-0 whitespace-pre-line">{action.action}</p>
                      <p className="m-0 flex flex-wrap gap-x-4 text-body-dense text-text-secondary">
                        {role ? <span>{t("care.plan.action.who", { role })}</span> : null}
                        {action.whenText ? (
                          <span>{t("care.plan.action.when", { when: action.whenText })}</span>
                        ) : null}
                        {action.evidenceRequired ? (
                          <span>{t("care.plan.action.evidence")}</span>
                        ) : null}
                      </p>
                    </div>
                    <RemoveAction
                      title={action.action}
                      disabled={pending}
                      onRemove={() => removeAction(action.id, action.version)}
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-text-secondary">{t("care.plan.section.noActions")}</p>
          )}
          {section ? (
            <form
              method="post"
              key={addRound}
              className="flex flex-col gap-4 rounded-input bg-bg-secondary p-4"
              onSubmit={addAction}
              noValidate
            >
              <p className="m-0 font-semibold">{t("care.plan.edit.addAction")}</p>
              <TextArea
                id={actionIds.action}
                error={errorFor(added, "action")}
                name="action"
                label={t("care.plan.edit.actionText")}
                hint={t("care.plan.edit.actionHint")}
                rows={2}
                maxLength={1000}
                formatCount={(remaining) => characterCount(remaining)}
              />
              <SelectField
                id={actionIds.roleKey}
                name="roleKey"
                label={t("care.plan.edit.role")}
                emptyOption={t("care.plan.edit.roleEmpty")}
                options={ACTION_ROLES.map((role) => ({
                  value: role,
                  label: t("care.plan.role", { role }),
                }))}
                className="max-w-sm"
              />
              <TextField
                id={actionIds.whenText}
                name="whenText"
                label={t("care.plan.edit.whenText")}
                hint={t("care.plan.edit.whenHint")}
                maxLength={200}
              />
              <Checkbox name="evidenceRequired" label={t("care.plan.edit.evidence")} />
              <div>
                <Button type="submit" variant="secondary" disabled={pending}>
                  {t("care.plan.edit.submitAction")}
                </Button>
              </div>
            </form>
          ) : (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("care.plan.edit.needFirst")}
            </p>
          )}
          <FormFeedback result={added} success={addedMessage} fieldIds={actionIds} />
        </section>
      </div>
    </details>
  );
}
