"use client";

import type { StatementOfPurposeContent } from "@harbour/contracts";
import { Button, Checkbox, SelectField, TextArea, TextField } from "@harbour/ui";
import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { saveStatementDraft, startStatementDraft } from "@/app/actions/quality";
import { useFieldIds } from "@/components/care/form-state";
import { characterCount, t } from "@/lib/i18n";
import { errorFor } from "@/lib/outcome";
import { LEGAL_STATUSES, LIMITS, newRowId, readStatementForm } from "@/lib/statement-of-purpose";
import { QualityFeedback, useQualitySend } from "./QualityForms";

const PATH = "/quality/statement-of-purpose";

const FIELDS = [
  "aimsAndObjectives",
  "serviceKinds",
  "needsMet",
  "providerName",
  "providerAddress",
  "providerPhone",
  "providerEmail",
  "serviceAddress",
  "consentsToEmailService",
  "serviceEmail",
  "legalStatus",
  "legalStatusDetail",
] as const;

type Manager = StatementOfPurposeContent["registeredManagers"][number];
type Place = StatementOfPurposeContent["locations"][number];

const blankManager = (): Manager => ({
  id: newRowId(),
  fullName: "",
  businessAddress: "",
  businessPhone: "",
  email: null,
});
const blankPlace = (): Place => ({ id: newRowId(), name: "", address: "", cqcLocationId: null });

/** A section of the statement, numbered as Schedule 3 numbers it. */
function Section({
  id,
  title,
  wording,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly wording: string;
  readonly children: React.ReactNode;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-4 border-0 border-t border-border p-0 pt-4">
      <legend id={id} className="mb-1 p-0 text-body font-semibold">
        {title}
      </legend>
      <p className="m-0 max-w-prose text-body-dense text-text-secondary">{wording}</p>
      {children}
    </fieldset>
  );
}

/**
 * The statement of purpose editor (QUAL-009; quality.md rules 11 and 12): every Schedule 3 item,
 * with registered managers and locations that can be added and removed, each keeping its id so the
 * change summary and the registration prompts follow it. A draft may be saved incomplete; the API
 * lists what is missing. With no `draft`, saving starts the baseline (the statement CQC already
 * holds). Saving as an editor means you cannot approve it, and the form says so.
 */
export function StatementEditor({
  draft,
  content,
}: {
  /** The draft being edited, or null to load the baseline. */
  readonly draft: { readonly id: string; readonly version: number } | null;
  readonly content: StatementOfPurposeContent;
}) {
  const ids = useFieldIds(FIELDS);
  const { result, pending, send, fail } = useQualitySend(PATH);
  const [managers, setManagers] = useState<Manager[]>([...content.registeredManagers]);
  const [places, setPlaces] = useState<Place[]>([...content.locations]);
  // Where focus goes after a row is added or removed (2.4.3), and what is said politely.
  const [focusTo, setFocusTo] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo)?.focus();
    setFocusTo(null);
  }, [focusTo]);
  const rowId = (key: string) => `sop-${key}`;
  const rowFieldIds = Object.fromEntries([
    ...managers.flatMap((_, i) =>
      ["managerName", "managerAddress", "managerPhone", "managerEmail"].map((k) => [
        `${k}-${i}`,
        rowId(`${k}-${i}`),
      ]),
    ),
    ...places.flatMap((_, i) =>
      ["locationName", "locationAddress", "locationCqcId"].map((k) => [
        `${k}-${i}`,
        rowId(`${k}-${i}`),
      ]),
    ),
  ]);
  const [status, setStatus] = useState<string>(content.legalStatus ?? "");
  const [consents, setConsents] = useState(content.consentsToEmailService);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readStatementForm(new FormData(event.currentTarget), t);
    if (!read.ok) return fail(read.errors);
    if (draft) {
      send("saved", () =>
        saveStatementDraft(draft.id, { content: read.content, version: draft.version }),
      );
    } else {
      send("drafted", () => startStatementDraft(read.content));
    }
  };
  const error = (field: string) => errorFor(result, field);
  const errorProps = (field: string) => (error(field) ? { error: error(field) } : {});
  const count = (remaining: number) => characterCount(remaining);

  return (
    <div className="flex flex-col gap-4">
      <form
        method="post"
        className="flex flex-col gap-6"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="editor-title"
      >
        <div className="flex flex-col gap-1">
          <h3 id="editor-title" className="m-0 text-body font-semibold">
            {t("quality.sop.editor.title", { mode: draft ? "draft" : "baseline" })}
          </h3>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("quality.sop.editor.intro", { mode: draft ? "draft" : "baseline" })}
          </p>
        </div>

        <Section
          id="sop-aims"
          title={t("quality.sop.item", { item: "aims_and_objectives" })}
          wording={t("quality.sop.wording", { item: "aims_and_objectives" })}
        >
          <TextArea
            id={ids.aimsAndObjectives}
            name="aimsAndObjectives"
            label={t("quality.sop.field.aims")}
            rows={5}
            maxLength={LIMITS.long}
            formatCount={count}
            defaultValue={content.aimsAndObjectives}
            {...errorProps("aimsAndObjectives")}
          />
        </Section>

        <Section
          id="sop-services"
          title={t("quality.sop.item", { item: "services_and_needs" })}
          wording={t("quality.sop.wording", { item: "services_and_needs" })}
        >
          <TextArea
            id={ids.serviceKinds}
            name="serviceKinds"
            label={t("quality.sop.field.serviceKinds")}
            hint={t("quality.sop.field.serviceKindsHint")}
            rows={3}
            defaultValue={content.serviceKinds.join("\n")}
            {...errorProps("serviceKinds")}
          />
          <TextArea
            id={ids.needsMet}
            name="needsMet"
            label={t("quality.sop.field.needsMet")}
            rows={5}
            maxLength={LIMITS.long}
            formatCount={count}
            defaultValue={content.needsMet}
            {...errorProps("needsMet")}
          />
        </Section>

        <Section
          id="sop-contacts"
          title={t("quality.sop.item", { item: "contact_details" })}
          wording={t("quality.sop.wording", { item: "contact_details" })}
        >
          <h4 className="m-0 text-body font-semibold">{t("quality.sop.field.provider")}</h4>
          <TextField
            id={ids.providerName}
            name="providerName"
            label={t("quality.sop.field.fullName")}
            maxLength={LIMITS.name}
            defaultValue={content.provider.fullName}
            autoComplete="off"
            {...errorProps("providerName")}
          />
          <TextArea
            id={ids.providerAddress}
            name="providerAddress"
            label={t("quality.sop.field.address")}
            rows={3}
            maxLength={LIMITS.address}
            formatCount={count}
            defaultValue={content.provider.businessAddress}
            {...errorProps("providerAddress")}
          />
          <TextField
            id={ids.providerPhone}
            name="providerPhone"
            type="tel"
            label={t("quality.sop.field.phone")}
            maxLength={LIMITS.phone}
            defaultValue={content.provider.businessPhone}
            autoComplete="off"
            {...errorProps("providerPhone")}
          />
          <TextField
            id={ids.providerEmail}
            name="providerEmail"
            type="email"
            label={t("quality.sop.field.email")}
            hint={t("quality.sop.field.emailHint")}
            maxLength={LIMITS.email}
            defaultValue={content.provider.email ?? ""}
            autoComplete="off"
            spellCheck={false}
            {...errorProps("providerEmail")}
          />

          <h4 className="m-0 text-body font-semibold">{t("quality.sop.field.managers")}</h4>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("quality.sop.field.managersHint")}
          </p>
          {managers.length === 0 ? (
            <p className="m-0">{t("quality.sop.field.noManagers")}</p>
          ) : null}
          {managers.map((manager, i) => {
            const n = i + 1;
            return (
              <fieldset
                key={manager.id}
                className="m-0 flex flex-col gap-3 rounded-input border border-border p-4"
              >
                <legend className="px-1 font-semibold">
                  {t("quality.sop.field.manager", { n })}
                </legend>
                <input type="hidden" name="managerId" value={manager.id} />
                <TextField
                  id={rowId(`managerName-${i}`)}
                  name="managerName"
                  label={t("quality.sop.field.fullName")}
                  maxLength={LIMITS.name}
                  defaultValue={manager.fullName}
                  autoComplete="off"
                  {...errorProps(`managerName-${i}`)}
                />
                <TextArea
                  id={rowId(`managerAddress-${i}`)}
                  name="managerAddress"
                  label={t("quality.sop.field.address")}
                  rows={2}
                  maxLength={LIMITS.address}
                  formatCount={count}
                  defaultValue={manager.businessAddress}
                  {...errorProps(`managerAddress-${i}`)}
                />
                <TextField
                  id={rowId(`managerPhone-${i}`)}
                  name="managerPhone"
                  type="tel"
                  label={t("quality.sop.field.phone")}
                  maxLength={LIMITS.phone}
                  defaultValue={manager.businessPhone}
                  autoComplete="off"
                  {...errorProps(`managerPhone-${i}`)}
                />
                <TextField
                  id={rowId(`managerEmail-${i}`)}
                  name="managerEmail"
                  type="email"
                  label={t("quality.sop.field.email")}
                  hint={t("quality.sop.field.emailHint")}
                  maxLength={LIMITS.email}
                  defaultValue={manager.email ?? ""}
                  autoComplete="off"
                  spellCheck={false}
                  {...errorProps(`managerEmail-${i}`)}
                />
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setManagers(managers.filter((m) => m.id !== manager.id));
                      setSaid(t("quality.sop.field.removed", { what: "manager", n }));
                      setFocusTo("sop-add-manager");
                    }}
                  >
                    <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
                    {t("quality.sop.field.removeManager", { n })}
                  </Button>
                </div>
              </fieldset>
            );
          })}
          {managers.length < LIMITS.managers ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                id="sop-add-manager"
                onClick={() => {
                  setManagers([...managers, blankManager()]);
                  setFocusTo(rowId(`managerName-${managers.length}`));
                }}
              >
                <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
                {t("quality.sop.field.addManager")}
              </Button>
            </div>
          ) : null}

          <h4 className="m-0 text-body font-semibold">{t("quality.sop.field.notices")}</h4>
          <TextArea
            id={ids.serviceAddress}
            name="serviceAddress"
            label={t("quality.sop.field.serviceAddress")}
            hint={t("quality.sop.field.serviceAddressHint")}
            rows={3}
            maxLength={LIMITS.address}
            formatCount={count}
            defaultValue={content.serviceAddress}
            {...errorProps("serviceAddress")}
          />
          <Checkbox
            id={ids.consentsToEmailService}
            name="consentsToEmailService"
            value="yes"
            label={t("quality.sop.field.consents")}
            checked={consents}
            onChange={(event) => setConsents(event.currentTarget.checked)}
          />
          {consents ? (
            <TextField
              id={ids.serviceEmail}
              name="serviceEmail"
              type="email"
              label={t("quality.sop.field.serviceEmail")}
              maxLength={LIMITS.email}
              defaultValue={content.serviceEmail ?? ""}
              autoComplete="off"
              spellCheck={false}
              {...errorProps("serviceEmail")}
            />
          ) : null}
        </Section>

        <Section
          id="sop-legal"
          title={t("quality.sop.item", { item: "legal_status" })}
          wording={t("quality.sop.wording", { item: "legal_status" })}
        >
          <SelectField
            id={ids.legalStatus}
            name="legalStatus"
            label={t("quality.sop.field.legalStatus")}
            emptyOption={t("quality.sop.field.legalStatusEmpty")}
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value)}
            options={LEGAL_STATUSES.map((s) => ({
              value: s,
              label: t("quality.sop.legalStatus", { status: s }),
            }))}
          />
          {status === "other" ? (
            <TextField
              id={ids.legalStatusDetail}
              name="legalStatusDetail"
              label={t("quality.sop.field.legalStatusDetail")}
              maxLength={LIMITS.legalDetail}
              defaultValue={content.legalStatusDetail ?? ""}
              autoComplete="off"
              {...errorProps("legalStatusDetail")}
            />
          ) : null}
        </Section>

        <Section
          id="sop-locations"
          title={t("quality.sop.item", { item: "locations" })}
          wording={t("quality.sop.wording", { item: "locations" })}
        >
          {places.length === 0 ? <p className="m-0">{t("quality.sop.field.noLocations")}</p> : null}
          {places.map((place, i) => {
            const n = i + 1;
            return (
              <fieldset
                key={place.id}
                className="m-0 flex flex-col gap-3 rounded-input border border-border p-4"
              >
                <legend className="px-1 font-semibold">
                  {t("quality.sop.field.location", { n })}
                </legend>
                <input type="hidden" name="locationId" value={place.id} />
                <TextField
                  id={rowId(`locationName-${i}`)}
                  name="locationName"
                  label={t("quality.sop.field.locationName")}
                  maxLength={LIMITS.name}
                  defaultValue={place.name}
                  autoComplete="off"
                  {...errorProps(`locationName-${i}`)}
                />
                <TextArea
                  id={rowId(`locationAddress-${i}`)}
                  name="locationAddress"
                  label={t("quality.sop.field.address")}
                  rows={2}
                  maxLength={LIMITS.address}
                  formatCount={count}
                  defaultValue={place.address}
                  {...errorProps(`locationAddress-${i}`)}
                />
                <TextField
                  id={rowId(`locationCqcId-${i}`)}
                  name="locationCqcId"
                  label={t("quality.sop.field.cqcLocationId")}
                  hint={t("quality.sop.field.cqcLocationIdHint")}
                  maxLength={LIMITS.cqcLocationId}
                  defaultValue={place.cqcLocationId ?? ""}
                  autoComplete="off"
                  spellCheck={false}
                  {...errorProps(`locationCqcId-${i}`)}
                />
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setPlaces(places.filter((p) => p.id !== place.id));
                      setSaid(t("quality.sop.field.removed", { what: "location", n }));
                      setFocusTo("sop-add-location");
                    }}
                  >
                    <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
                    {t("quality.sop.field.removeLocation", { n })}
                  </Button>
                </div>
              </fieldset>
            );
          })}
          {places.length < LIMITS.locations ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                id="sop-add-location"
                onClick={() => {
                  setPlaces([...places, blankPlace()]);
                  setFocusTo(rowId(`locationName-${places.length}`));
                }}
              >
                <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
                {t("quality.sop.field.addLocation")}
              </Button>
            </div>
          ) : null}
        </Section>

        <p className="m-0 max-w-prose text-body-dense">{t("quality.sop.editor.editorNote")}</p>
        <div>
          <Button type="submit" disabled={pending}>
            {pending
              ? t("common.saving")
              : t("quality.sop.editor.submit", { mode: draft ? "draft" : "baseline" })}
          </Button>
        </div>
      </form>
      <p role="status" className="m-0 text-body-dense">
        {said}
      </p>
      <QualityFeedback result={result} path={PATH} fieldIds={{ ...ids, ...rowFieldIds }} />
    </div>
  );
}
