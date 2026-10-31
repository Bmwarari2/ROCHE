import {
  type BodyMarkType,
  type BodySide,
  type BodyView,
  findBodyRegion,
  markTriggers,
  PRESSURE_ULCER_CATEGORIES,
  type PressureUlcerCategory,
} from "@harbour/domain";
import { Text } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import {
  BODY_VIEWS,
  checkMark,
  type DrawnPoint,
  MARK_DESCRIPTION_MAX,
  MARK_TYPES,
  type MarkField,
  PRESSURE_CATEGORIES,
  regionsFor,
  type ViewerZone,
} from "../../../../care/body-map";
import type { FieldError } from "../../../../care/entries";
import { markSummary } from "../../../../care/entry-view";
import { useEntryContext, useTenantId, useWhenChoice } from "../../../../care/hooks";
import { MARK_BY_ID_SQL, type MarkRow } from "../../../../care/queries";
import { useSaveAndReturn } from "../../../../care/use-save";
import { BodyMapDrawing } from "../../../../components/BodyMapDrawing";
import { FormScreen } from "../../../../components/FormScreen";
import {
  ChoiceGroup,
  CorrectionField,
  FieldMessage,
  WhenField,
  YesNoField,
} from "../../../../components/forms";
import { TextField } from "../../../../components/TextField";
import { t } from "../../../../i18n/t";
import { useRecordScreenProtection } from "../../../../security/use-record-protection";

const sideWords = (side: BodySide) => t("mobile.bodyMap.sideWords", { side });

/** Add a body map mark offline: the side on the drawing and in words must agree (HZ-019). */
export default function BodyMapScreen() {
  useRecordScreenProtection("body-map");
  const params = useLocalSearchParams<{ personId: string; correct?: string; task?: string }>();
  const id = typeof params.personId === "string" ? params.personId : "";
  const correctId = typeof params.correct === "string" && params.correct ? params.correct : null;
  const tenantId = useTenantId();
  // The round's task this entry answers, when the carer came from the round (gate item (f)).
  const context = useEntryContext(
    id,
    !params.correct && typeof params.task === "string" ? params.task : null,
    { table: "body_map_mark" },
  );
  const { submit, saving, saveFailed } = useSaveAndReturn();

  const [view, setView] = useState<BodyView>("front");
  const [zone, setZone] = useState<ViewerZone | null>(null);
  const [point, setPoint] = useState<DrawnPoint | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [side, setSide] = useState<BodySide | null>(null);
  const [markType, setMarkType] = useState<BodyMarkType | null>(null);
  const [pressureCategory, setPressureCategory] = useState<PressureUlcerCategory | null>(null);
  const [deviceRelated, setDeviceRelated] = useState<boolean | null>(null);
  const [bruiseExplained, setBruiseExplained] = useState<boolean | null>(null);
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Partial<Record<MarkField, FieldError>>>({});

  const originalParams = useMemo(() => [tenantId, id, correctId ?? ""], [tenantId, id, correctId]);
  const { data: originals } = useQuery<MarkRow>(MARK_BY_ID_SQL, originalParams);
  const original = correctId ? (originals[0] ?? null) : null;
  const [when, setWhen] = useWhenChoice(original?.occurred_at);

  const regions = regionsFor(view);
  const chosenRegion = region ? findBodyRegion(view, region) : undefined;
  const sides: readonly BodySide[] = chosenRegion?.sides ?? ["left", "right", "midline"];
  const prompts =
    markType !== null &&
    markTriggers({
      markType,
      pressureUlcerCategory: markType === "pressure_ulcer" ? pressureCategory : null,
      bruiseExplained: markType === "bruise" ? bruiseExplained : null,
    }).length > 0;

  const changeView = (next: BodyView) => {
    // A new view means a new drawing and a different list of areas.
    setView(next);
    setZone(null);
    setPoint(null);
    setRegion(null);
  };

  const save = () => {
    const result = checkMark(
      {
        view,
        zone,
        point,
        region,
        side,
        markType,
        pressureCategory,
        deviceRelated,
        bruiseExplained,
        description,
        when,
        correction: correctId ? { supersedesId: correctId, reason } : null,
      },
      context,
      new Date(),
      sideWords,
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    void submit("body_map_mark", result.row);
  };

  return (
    <FormScreen
      personId={id}
      title={t(correctId ? "mobile.bodyMap.correctTitle" : "mobile.bodyMap.title")}
      testID="body-map-screen"
      showErrors={Object.keys(errors).length > 0}
      saveFailed={saveFailed}
      saving={saving}
      onSave={save}
    >
      {correctId ? (
        <CorrectionField
          original={original ? markSummary(original) : ""}
          reason={reason}
          onChange={setReason}
          error={errors.reason}
        />
      ) : null}
      <ChoiceGroup
        label={t("mobile.bodyMap.view")}
        testID="mark-view"
        value={view}
        onChange={changeView}
        options={BODY_VIEWS.map((value) => ({
          value,
          label: t("mobile.bodyMap.viewName", { view: value }),
        }))}
      />
      <Text emphasis accessibilityRole="header">
        {t("mobile.bodyMap.drawing")}
      </Text>
      <BodyMapDrawing
        view={view}
        zone={zone}
        onZone={(nextZone, nextPoint) => {
          setZone(nextZone);
          setPoint(nextPoint);
        }}
      />
      <FieldMessage error={errors.zone} />
      <ChoiceGroup
        label={t("mobile.bodyMap.region")}
        testID="mark-region"
        value={region}
        onChange={setRegion}
        options={regions.map((r) => ({ value: r.region, label: r.label }))}
        error={errors.region}
      />
      <ChoiceGroup
        label={t("mobile.bodyMap.side")}
        testID="mark-side"
        value={side}
        onChange={setSide}
        options={sides.map((value) => ({
          value,
          label: t("mobile.bodyMap.sideName", { side: value }),
        }))}
        error={errors.side}
      />
      <ChoiceGroup
        label={t("mobile.bodyMap.markType")}
        testID="mark-type"
        value={markType}
        onChange={setMarkType}
        options={MARK_TYPES.map((value) => ({
          value,
          label: t("mobile.bodyMap.markTypeName", { type: value }),
        }))}
        error={errors.markType}
      />
      {markType === "pressure_ulcer" ? (
        <>
          <ChoiceGroup
            label={t("mobile.bodyMap.category")}
            testID="mark-category"
            value={pressureCategory}
            onChange={setPressureCategory}
            options={PRESSURE_CATEGORIES.map((value) => ({
              value,
              label: PRESSURE_ULCER_CATEGORIES[value],
            }))}
            error={errors.pressureCategory}
          />
          <YesNoField
            label={t("mobile.bodyMap.deviceRelated")}
            value={deviceRelated}
            onChange={setDeviceRelated}
            error={errors.deviceRelated}
            testID="mark-device-related"
          />
        </>
      ) : null}
      {markType === "bruise" ? (
        <YesNoField
          label={t("mobile.bodyMap.bruiseExplained")}
          value={bruiseExplained}
          onChange={setBruiseExplained}
          error={errors.bruiseExplained}
          testID="mark-bruise-explained"
        />
      ) : null}
      {prompts ? (
        <Text tone="warning" emphasis accessibilityRole="alert" testID="mark-prompts">
          {t("mobile.bodyMap.prompts")}
        </Text>
      ) : null}
      <TextField
        label={t("mobile.form.optional", { label: t("mobile.bodyMap.description") })}
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={MARK_DESCRIPTION_MAX}
        minHeight={88}
        testID="mark-description"
      />
      <WhenField
        value={when}
        onChange={setWhen}
        error={errors.when}
        windowDays={context.windowDays ?? null}
        toleranceMinutes={context.clockToleranceMinutes ?? 0}
        original={original?.occurred_at ?? null}
      />
    </FormScreen>
  );
}
