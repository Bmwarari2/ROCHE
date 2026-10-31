"use client";

import type { CreateBodyMapMark, OutageItem } from "@harbour/contracts";
import {
  Button,
  RadioGroup,
  SegmentedControl,
  SelectField,
  TextArea,
  TextField,
} from "@harbour/ui";
import { type FormEvent, useState, useTransition } from "react";
import { recordBodyMark } from "@/app/actions/care-record";
import { readNumber, readYesNo } from "@/lib/assessments";
import { keptForReview, PAPER_FIELDS, readEntryWhen } from "@/lib/back-entry";
import {
  BODY_REGIONS,
  type BodySide,
  type BodyView,
  drawnPoint,
  parseRegionValue,
  regionSides,
  regionValue,
} from "@/lib/body-map";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, collectedRefusal, errorFor, partsFor, refused } from "@/lib/outcome";

import { BodyDrawing, type DrawnMark } from "./BodyDrawing";
import { FormFeedback } from "./FormFeedback";
import { useEntryId, useFieldIds } from "./form-state";
import { WhenField } from "./WhenField";

type MarkType = CreateBodyMapMark["markType"];

const MARK_TYPES = [
  "bruise",
  "pressure_ulcer",
  "moisture_associated_skin_damage",
  "skin_tear",
  "laceration",
  "burn",
  "rash",
  "wound",
  "other",
] as const satisfies readonly MarkType[];

const CATEGORIES = [
  "category_1",
  "category_2",
  "category_3",
  "category_4",
  "unstageable",
  "deep_tissue_injury",
] as const satisfies readonly NonNullable<CreateBodyMapMark["pressureCategory"]>[];

const SIDES: readonly BodySide[] = ["left", "right", "midline"];

const FIELDS = [
  "region",
  "side",
  "markType",
  "pressureCategory",
  "deviceRelated",
  "bruiseExplained",
  "occurredAt",
  ...PAPER_FIELDS,
] as const;

function placeLabel(view: BodyView, value: string): string | null {
  const parsed = parseRegionValue(view, value);
  return parsed
    ? t("care.bodyMap.region.option", {
        region: t("care.bodyMap.regionName", { region: parsed.region }),
        side: parsed.side,
      })
    : null;
}

/**
 * Record a body-map mark (care.md rule 7, hazard HZ-019). The place is chosen on the drawing or
 * from the list (which match), and the side is then confirmed in words. The two are sent as they
 * are: the API refuses a mark whose stated side differs from the drawing, and the refusal is shown
 * at the side question and the body area list, with a summary that links to them.
 */
export function BodyMapRecorder({
  personId,
  outages = [],
  marks,
}: {
  readonly personId: string;
  /** Outages a paper record can be entered against at the person's location. */
  readonly outages?: readonly OutageItem[];
  /** Current marks on each view, drawn as dots. */
  readonly marks: Readonly<Record<BodyView, readonly DrawnMark[]>>;
}) {
  const [view, setView] = useState<BodyView>("front");
  const [place, setPlace] = useState<string | null>(null);
  const [side, setSide] = useState<BodySide | null>(null);
  const [markType, setMarkType] = useState<MarkType | "">("");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useFieldIds(FIELDS);
  const entry = useEntryId();
  const marked = place ? placeLabel(view, place) : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const drawn = place ? parseRegionValue(view, place) : null;
    const point = place ? drawnPoint(view, place) : null;
    if (!drawn) return setResult(refused(t("care.bodyMap.regionRequired"), "invalid", ["region"]));
    if (!side) return setResult(refused(t("care.bodyMap.sideRequired"), "invalid", ["side"]));
    if (!markType) {
      return setResult(refused(t("care.bodyMap.markTypeRequired"), "invalid", ["markType"]));
    }
    const size = (key: string) => {
      const value = readNumber(form.get(key));
      return value === null ? {} : { [key]: value };
    };
    const category = String(form.get("pressureCategory") ?? "");
    const deviceRelated = readYesNo(form.get("deviceRelated"));
    const bruiseExplained = readYesNo(form.get("bruiseExplained"));
    // The API refuses these too; asking here says which question is missing before sending.
    if (markType === "pressure_ulcer" && !category) {
      return setResult(
        refused(t("care.bodyMap.categoryRequired"), "invalid", ["pressureCategory"]),
      );
    }
    if (markType === "pressure_ulcer" && deviceRelated === null) {
      return setResult(refused(t("care.bodyMap.deviceRequired"), "invalid", ["deviceRelated"]));
    }
    if (markType === "bruise" && bruiseExplained === null) {
      return setResult(refused(t("care.bodyMap.bruiseRequired"), "invalid", ["bruiseExplained"]));
    }
    const when = readEntryWhen(form, "occurredAt", t, outages);
    if (!when.ok) return setResult(collectedRefusal(when.problems));
    startTransition(async () => {
      const outcome = await recordBodyMark(personId, {
        id: entry.id,
        occurredAt: when.instant,
        downtime: when.downtime,
        sentAt: new Date().toISOString(),
        view,
        region: drawn.region,
        // The place on the drawing: the API works out the side from it (HZ-019).
        ...(point ? { drawnAt: point } : {}),
        drawnSide: drawn.side,
        side,
        markType,
        status: form.get("status") === "healed" ? "healed" : "present",
        description: String(form.get("description") ?? ""),
        ...(markType === "pressure_ulcer" && category
          ? { pressureCategory: category as (typeof CATEGORIES)[number] }
          : {}),
        ...(markType === "pressure_ulcer" && deviceRelated !== null ? { deviceRelated } : {}),
        ...(markType === "bruise" && bruiseExplained !== null ? { bruiseExplained } : {}),
        ...size("lengthMm"),
        ...size("widthMm"),
        ...size("depthMm"),
      });
      setResult(outcome);
      // Kept for review after a reconciled outage: start again, so it is not saved twice.
      if (outcome.ok || keptForReview(outcome)) {
        setRound((n) => n + 1);
        setPlace(null);
        setSide(null);
        setMarkType("");
        entry.next();
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form method="post" key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <SegmentedControl<BodyView>
          label={t("care.bodyMap.view")}
          value={view}
          onValueChange={(next) => {
            setView(next);
            setPlace(null);
          }}
          options={(["front", "back"] as const).map((v) => ({
            value: v,
            label: t("care.bodyMap.viewOption", { view: v }),
          }))}
        />
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <div className="flex flex-col gap-2">
            <BodyDrawing view={view} selected={place} marks={marks[view]} onSelect={setPlace} />
            <p className="m-0 max-w-[240px] text-body-dense text-text-secondary">
              {t("care.bodyMap.drawingHint")}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <SelectField
              id={ids.region}
              error={errorFor(result, "region")}
              name="region"
              label={t("care.bodyMap.region.label")}
              hint={t("care.bodyMap.region.hint")}
              emptyOption={t("care.bodyMap.region.empty")}
              value={place ?? ""}
              onChange={(event) => setPlace(event.currentTarget.value || null)}
              groups={BODY_REGIONS[view].map((placement) => ({
                label: t("care.bodyMap.regionName", { region: placement.region }),
                options: regionSides(view, placement.region).map((s) => ({
                  value: regionValue(placement.region, s),
                  label: t("care.bodyMap.region.option", {
                    region: t("care.bodyMap.regionName", { region: placement.region }),
                    side: s,
                  }),
                })),
              }))}
            />
            <p role="status" className="m-0 font-semibold">
              {marked ? t("care.bodyMap.marked", { place: marked }) : null}
            </p>
            <RadioGroup<BodySide>
              id={ids.side}
              error={errorFor(result, "side")}
              legend={t("care.bodyMap.side.legend")}
              hint={t("care.bodyMap.side.hint")}
              name="side"
              layout="inline"
              value={side}
              onValueChange={setSide}
              options={SIDES.map((s) => ({
                value: s,
                label: t("care.bodyMap.sideOption", { side: s }),
              }))}
            />
            <SelectField
              id={ids.markType}
              error={errorFor(result, "markType")}
              name="markType"
              label={t("care.bodyMap.markType")}
              emptyOption={t("care.bodyMap.markTypeEmpty")}
              value={markType}
              onChange={(event) => setMarkType(event.currentTarget.value as MarkType | "")}
              options={MARK_TYPES.map((type) => ({
                value: type,
                label: t("care.bodyMap.markTypeOption", { type }),
              }))}
            />
            {markType === "pressure_ulcer" ? (
              <>
                <SelectField
                  id={ids.pressureCategory}
                  error={errorFor(result, "pressureCategory")}
                  name="pressureCategory"
                  label={t("care.bodyMap.category")}
                  emptyOption={t("care.bodyMap.categoryEmpty")}
                  required
                  options={CATEGORIES.map((category) => ({
                    value: category,
                    label: t("care.bodyMap.categoryOption", { category }),
                  }))}
                />
                <RadioGroup
                  id={ids.deviceRelated}
                  error={errorFor(result, "deviceRelated")}
                  legend={t("care.bodyMap.deviceRelated")}
                  name="deviceRelated"
                  required
                  layout="inline"
                  options={[
                    { value: "yes", label: t("care.common.yes") },
                    { value: "no", label: t("care.common.no") },
                  ]}
                />
              </>
            ) : null}
            {markType === "bruise" ? (
              <RadioGroup
                id={ids.bruiseExplained}
                error={errorFor(result, "bruiseExplained")}
                legend={t("care.bodyMap.bruiseExplained")}
                name="bruiseExplained"
                required
                layout="inline"
                options={[
                  { value: "yes", label: t("care.common.yes") },
                  { value: "no", label: t("care.common.no") },
                ]}
              />
            ) : null}
            {markType === "pressure_ulcer" || markType === "bruise" ? (
              <p className="m-0 text-body-dense text-text-secondary">{t("care.bodyMap.prompts")}</p>
            ) : null}
          </div>
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 font-semibold">{t("care.bodyMap.size")}</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <TextField
              name="lengthMm"
              label={t("care.bodyMap.length")}
              inputMode="decimal"
              autoComplete="off"
            />
            <TextField
              name="widthMm"
              label={t("care.bodyMap.width")}
              inputMode="decimal"
              autoComplete="off"
            />
            <TextField
              name="depthMm"
              label={t("care.bodyMap.depth")}
              inputMode="decimal"
              autoComplete="off"
            />
          </div>
        </fieldset>
        <TextArea
          name="description"
          label={t("care.bodyMap.markDescription")}
          rows={3}
          maxLength={1000}
          formatCount={(remaining) => characterCount(remaining)}
        />
        <RadioGroup
          legend={t("care.bodyMap.status")}
          name="status"
          layout="inline"
          defaultValue="present"
          options={(["present", "healed"] as const).map((status) => ({
            value: status,
            label: t("care.bodyMap.statusOption", { status }),
          }))}
        />
        <WhenField
          id={ids.occurredAt}
          error={errorFor(result, "occurredAt")}
          errorParts={partsFor(result, "occurredAt")}
          paper={{ outages, ids, result }}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.bodyMap.submit")}
          </Button>
        </div>
      </form>
      {/* The API's answer does not say whether follow-up tasks were raised (only for marks still
          present), so the saved message never predicts them (HZ-027 review). */}
      <FormFeedback result={result} success={t("care.bodyMap.savedFollowUp")} fieldIds={ids} />
    </div>
  );
}
