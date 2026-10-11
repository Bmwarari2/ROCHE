"use client";

import type { CreateBodyMapMark } from "@harbour/contracts";
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
import {
  BODY_REGIONS,
  type BodySide,
  type BodyView,
  parseRegionValue,
  regionSides,
  regionValue,
} from "@/lib/body-map";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { readWhen } from "@/lib/uk-time";
import { BodyDrawing, type DrawnMark } from "./BodyDrawing";
import { FormFeedback } from "./FormFeedback";
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
 * are: the API refuses a mark whose stated side differs from the drawing, and that refusal is
 * shown word for word.
 */
export function BodyMapRecorder({
  personId,
  marks,
}: {
  readonly personId: string;
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
  const marked = place ? placeLabel(view, place) : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const drawn = place ? parseRegionValue(view, place) : null;
    if (!drawn) return setResult(refused(t("care.bodyMap.regionRequired")));
    if (!side) return setResult(refused(t("care.bodyMap.sideRequired")));
    if (!markType) return setResult(refused(t("care.bodyMap.markTypeRequired")));
    const size = (key: string) => {
      const value = readNumber(form.get(key));
      return value === null ? {} : { [key]: value };
    };
    const category = String(form.get("pressureCategory") ?? "");
    const deviceRelated = readYesNo(form.get("deviceRelated"));
    const bruiseExplained = readYesNo(form.get("bruiseExplained"));
    const when = readWhen(form, "occurredAt", t);
    if (!when.ok) return setResult(refused(when.message));
    startTransition(async () => {
      const outcome = await recordBodyMark(personId, {
        occurredAt: when.instant,
        sentAt: new Date().toISOString(),
        view,
        region: drawn.region,
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
      if (outcome.ok) {
        setRound((n) => n + 1);
        setPlace(null);
        setSide(null);
        setMarkType("");
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form key={round} className="flex flex-col gap-4" onSubmit={submit} noValidate>
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
            <p className="m-0 max-w-[240px] text-callout text-text-secondary">
              {t("care.bodyMap.drawingHint")}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <SelectField
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
            <p role="status" className="m-0 font-semibold empty:hidden">
              {marked ? t("care.bodyMap.marked", { place: marked }) : null}
            </p>
            <RadioGroup<BodySide>
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
                  name="pressureCategory"
                  label={t("care.bodyMap.category")}
                  emptyOption={t("care.bodyMap.categoryEmpty")}
                  options={CATEGORIES.map((category) => ({
                    value: category,
                    label: t("care.bodyMap.categoryOption", { category }),
                  }))}
                />
                <RadioGroup
                  legend={t("care.bodyMap.deviceRelated")}
                  name="deviceRelated"
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
                legend={t("care.bodyMap.bruiseExplained")}
                name="bruiseExplained"
                layout="inline"
                options={[
                  { value: "yes", label: t("care.common.yes") },
                  { value: "no", label: t("care.common.no") },
                ]}
              />
            ) : null}
            {markType === "pressure_ulcer" || markType === "bruise" ? (
              <p className="m-0 text-callout text-text-secondary">{t("care.bodyMap.prompts")}</p>
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
        <WhenField />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("common.saving") : t("care.bodyMap.submit")}
          </Button>
        </div>
      </form>
      <FormFeedback result={result} success={t("care.bodyMap.saved")} />
    </div>
  );
}
