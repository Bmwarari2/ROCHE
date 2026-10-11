import { BRISTOL_STOOL_SCALE, describeIddsiLevel } from "@harbour/domain";
import { Button, FlagChip, iconByName, Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useVault } from "../../../../app-state/vault";
import {
  BOWEL_AMOUNTS,
  BRISTOL_TYPES,
  CHART_KINDS,
  CHART_LIMITS,
  type ChartDraft,
  type ChartErrors,
  type ChartKind,
  CONSCIOUSNESS_LEVELS,
  checkChart,
  IDDSI_DRINK_CODES,
  IDDSI_FOOD_CODES,
  isChartKind,
  MEALS,
  OUTPUT_KINDS,
  PORTIONS,
  POSITIONS,
  prescribedLevel,
  previewNews2,
  toStoredNews2,
  WEIGH_METHODS,
} from "../../../../care/charts";
import { currentEntries } from "../../../../care/entries";
import { observationItem } from "../../../../care/entry-view";
import {
  useCareProfileState,
  useEntryContext,
  useTenantId,
  useWhenChoice,
} from "../../../../care/hooks";
import {
  OBSERVATION_BY_ID_SQL,
  OBSERVATIONS_SQL,
  type ObservationRow,
  observationParams,
} from "../../../../care/queries";
import { useSaveAndReturn } from "../../../../care/use-save";
import { Card } from "../../../../components/Card";
import { EntryRow } from "../../../../components/EntryRow";
import { FormScreen } from "../../../../components/FormScreen";
import {
  ChoiceGroup,
  type ChoiceOption,
  CorrectionField,
  errorText,
  WhenField,
  YesNoField,
} from "../../../../components/forms";
import { News2Panel } from "../../../../components/News2Panel";
import { TextField } from "../../../../components/TextField";
import { appEnv } from "../../../../config/app-env";
import { type MessageKey, t } from "../../../../i18n/t";
import { useRecordScreenProtection } from "../../../../security/use-record-protection";

function options<T extends string>(
  values: readonly T[],
  key: MessageKey,
  name: string,
): ChoiceOption<T>[] {
  return values.map((value) => ({ value, label: t(key, { [name]: value }) }));
}

/** Record a chart offline: fluids, food, repositioning, bowel, weight or vital signs. */
export default function ChartScreen() {
  useRecordScreenProtection("chart");
  const theme = useTheme();
  const vault = useVault();
  const params = useLocalSearchParams<{ personId: string; chart?: string; correct?: string }>();
  const id = typeof params.personId === "string" ? params.personId : "";
  const correctId = typeof params.correct === "string" && params.correct ? params.correct : null;
  const initialChart =
    typeof params.chart === "string" && isChartKind(params.chart) ? params.chart : null;
  const tenantId = useTenantId();
  const context = useEntryContext(id);
  const { profile, loaded: profileLoaded } = useCareProfileState(id);
  const { submit, saving, saveFailed } = useSaveAndReturn();

  const [chart, setChart] = useState<ChartKind | null>(initialChart);
  const [text, setText] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<Record<string, string | null>>({});
  const [yesNo, setYesNo] = useState<Record<string, boolean | null>>({});
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<ChartErrors>({});

  const originalParams = useMemo(() => [tenantId, id, correctId ?? ""], [tenantId, id, correctId]);
  const { data: originals } = useQuery<ObservationRow>(OBSERVATION_BY_ID_SQL, originalParams);
  const original =
    correctId && originals[0] ? observationItem(originals[0], appEnv.demoMode) : null;
  const [when, setWhen] = useWhenChoice(correctId ? originals[0]?.occurred_at : null);

  const earlierParams = useMemo(
    () => observationParams(tenantId, id, chart ?? "none"),
    [tenantId, id, chart],
  );
  const { data: earlierRows } = useQuery<ObservationRow>(OBSERVATIONS_SQL, earlierParams);
  const earlier = useMemo(
    () =>
      currentEntries(earlierRows)
        .slice(0, 5)
        .map((r) => observationItem(r, appEnv.demoMode)),
    [earlierRows],
  );

  const draft: ChartDraft | null = chart
    ? {
        chart,
        text,
        choice,
        yesNo,
        when,
        correction: correctId ? { supersedesId: correctId, reason } : null,
      }
    : null;
  const careProfile = profile
    ? {
        iddsi_food_level: profile.iddsi_food_level,
        iddsi_drink_level: profile.iddsi_drink_level,
        spo2_scale2: profile.spo2_scale2,
      }
    : null;
  const preview = draft && chart === "vitals" ? previewNews2(draft, careProfile) : null;

  const setTextField = (field: string) => (value: string) =>
    setText((current) => ({ ...current, [field]: value }));
  const setChoiceField = (field: string) => (value: string) =>
    setChoice((current) => ({ ...current, [field]: value }));
  const setYesNoField = (field: string) => (value: boolean) =>
    setYesNo((current) => ({ ...current, [field]: value }));

  const save = () => {
    if (!draft) return;
    const result = checkChart(draft, careProfile, context, new Date());
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    void submit("observation", result.row);
  };

  const numberField = (field: string, label: string, decimal = false) => (
    <TextField
      key={field}
      label={label}
      value={text[field] ?? ""}
      onChangeText={setTextField(field)}
      keyboardType={decimal ? "decimal-pad" : "number-pad"}
      errorText={errorText(errors[field])}
      testID={`chart-${field}`}
    />
  );

  const iddsiField = (kind: "food" | "drink") => {
    const prescribedCode =
      kind === "food" ? careProfile?.iddsi_food_level : careProfile?.iddsi_drink_level;
    const prescribed = prescribedLevel(kind, careProfile);
    const codes = kind === "food" ? IDDSI_FOOD_CODES : IDDSI_DRINK_CODES;
    const chosen = choice.iddsiLevel ?? null;
    const unrecorded = profileLoaded && !careProfile;
    return (
      <View style={{ gap: theme.space[1] }}>
        {unrecorded ? (
          <FlagChip
            tone="warning"
            icon={iconByName("circle-help")}
            label={t("mobile.header.iddsiNotRecorded")}
            testID="chart-iddsi-not-recorded"
          />
        ) : null}
        <ChoiceGroup
          label={t(kind === "food" ? "mobile.iddsi.food" : "mobile.iddsi.drink")}
          hint={
            prescribed
              ? t("mobile.iddsi.prescribed", { level: prescribed })
              : t("mobile.iddsi.noPrescribed")
          }
          testID="chart-iddsi"
          value={chosen}
          onChange={setChoiceField("iddsiLevel")}
          options={codes.map((code) => {
            const level = describeIddsiLevel(kind, code);
            return {
              value: code,
              label:
                code === prescribedCode ? t("mobile.iddsi.prescribedChoice", { level }) : level,
            };
          })}
          error={errors.iddsiLevel}
        />
        {chosen && prescribedCode && chosen !== prescribedCode ? (
          <TextField
            label={t("mobile.iddsi.reason")}
            hint={t("mobile.iddsi.reasonHint")}
            value={text.overrideReason ?? ""}
            onChangeText={setTextField("overrideReason")}
            maxLength={CHART_LIMITS.overrideReason.max}
            errorText={errorText(errors.overrideReason)}
            testID="chart-iddsi-reason"
          />
        ) : null}
        {chosen && !careProfile ? (
          <YesNoField
            label={t("mobile.iddsi.confirmLabel")}
            value={yesNo.levelChecked ?? null}
            onChange={setYesNoField("levelChecked")}
            error={errors.levelChecked}
            testID="chart-iddsi-checked"
          />
        ) : null}
      </View>
    );
  };

  const fields = () => {
    switch (chart) {
      case "fluid_intake":
        return (
          <>
            {numberField("ml", t("mobile.chart.ml"))}
            <TextField
              label={t("mobile.form.optional", { label: t("mobile.chart.drink") })}
              value={text.drink ?? ""}
              onChangeText={setTextField("drink")}
              maxLength={CHART_LIMITS.drink.max}
              testID="chart-drink"
            />
            {iddsiField("drink")}
            <YesNoField
              label={t("mobile.chart.refusedDrink")}
              value={yesNo.refused ?? false}
              onChange={setYesNoField("refused")}
              testID="chart-refused"
            />
          </>
        );
      case "fluid_output":
        return (
          <>
            {numberField("ml", t("mobile.chart.ml"))}
            <ChoiceGroup
              label={t("mobile.chart.outputKind")}
              testID="chart-kind"
              value={choice.kind ?? null}
              onChange={setChoiceField("kind")}
              options={options(OUTPUT_KINDS, "mobile.chart.outputKindName", "kind")}
              error={errors.kind}
            />
          </>
        );
      case "food":
        return (
          <>
            <ChoiceGroup
              label={t("mobile.chart.meal")}
              testID="chart-meal"
              value={choice.meal ?? null}
              onChange={setChoiceField("meal")}
              options={options(MEALS, "mobile.chart.mealName", "meal")}
              error={errors.meal}
            />
            <ChoiceGroup
              label={t("mobile.chart.portion")}
              testID="chart-portion"
              value={choice.portion ?? null}
              onChange={setChoiceField("portion")}
              options={options(PORTIONS, "mobile.chart.portionName", "portion")}
              error={errors.portion}
            />
            {iddsiField("food")}
            <TextField
              label={t("mobile.form.optional", { label: t("mobile.chart.foodDescription") })}
              value={text.description ?? ""}
              onChangeText={setTextField("description")}
              maxLength={CHART_LIMITS.foodDescription.max}
              testID="chart-description"
            />
            <YesNoField
              label={t("mobile.chart.refusedFood")}
              value={yesNo.refused ?? false}
              onChange={setYesNoField("refused")}
              testID="chart-refused"
            />
          </>
        );
      case "repositioning":
        return (
          <>
            <ChoiceGroup
              label={t("mobile.chart.position")}
              testID="chart-position"
              value={choice.position ?? null}
              onChange={setChoiceField("position")}
              options={options(POSITIONS, "mobile.chart.positionName", "position")}
              error={errors.position}
            />
            <YesNoField
              label={t("mobile.chart.skinChecked")}
              value={yesNo.skinChecked ?? null}
              onChange={setYesNoField("skinChecked")}
              error={errors.skinChecked}
              testID="chart-skin"
            />
            <YesNoField
              label={t("mobile.chart.declined")}
              value={yesNo.declined ?? false}
              onChange={setYesNoField("declined")}
              testID="chart-declined"
            />
          </>
        );
      case "bowel":
        return (
          <>
            <ChoiceGroup
              label={t("mobile.chart.bristol")}
              testID="chart-bristol"
              value={choice.bristolType ?? null}
              onChange={setChoiceField("bristolType")}
              options={[
                ...BRISTOL_TYPES.map((type) => ({
                  value: String(type),
                  label: t("mobile.chart.bristolType", {
                    type,
                    description: BRISTOL_STOOL_SCALE[type as keyof typeof BRISTOL_STOOL_SCALE],
                  }),
                })),
                { value: "none", label: t("mobile.chart.noMovement") },
              ]}
              error={errors.bristolType}
            />
            <ChoiceGroup
              label={t("mobile.form.optional", { label: t("mobile.chart.amount") })}
              testID="chart-amount"
              value={choice.amount ?? null}
              onChange={setChoiceField("amount")}
              options={options(BOWEL_AMOUNTS, "mobile.chart.amountName", "amount")}
              error={errors.amount}
            />
          </>
        );
      case "weight":
        return (
          <>
            {numberField("kg", t("mobile.chart.kg"), true)}
            <ChoiceGroup
              label={t("mobile.chart.method")}
              testID="chart-method"
              value={choice.method ?? null}
              onChange={setChoiceField("method")}
              options={options(WEIGH_METHODS, "mobile.chart.methodName", "method")}
              error={errors.method}
            />
          </>
        );
      case "vitals":
        return (
          <>
            {numberField("respirationRate", t("mobile.vitals.respirationRate"))}
            {numberField("spo2", t("mobile.vitals.spo2"))}
            <Text variant="bodyDense" tone="secondary" testID="chart-spo2-scale">
              {t("mobile.vitals.spo2Scale", {
                scale: careProfile?.spo2_scale2 === 1 ? "two" : "one",
              })}
            </Text>
            <ChoiceGroup
              label={t("mobile.vitals.oxygen")}
              testID="chart-oxygen"
              value={
                yesNo.onOxygen === undefined || yesNo.onOxygen === null
                  ? null
                  : yesNo.onOxygen
                    ? "oxygen"
                    : "air"
              }
              onChange={(value) => setYesNoField("onOxygen")(value === "oxygen")}
              options={[
                { value: "air", label: t("mobile.vitals.air") },
                { value: "oxygen", label: t("mobile.vitals.onOxygen") },
              ]}
              error={errors.onOxygen}
            />
            {numberField("systolic", t("mobile.vitals.systolic"))}
            {numberField("pulse", t("mobile.vitals.pulse"))}
            <ChoiceGroup
              label={t("mobile.vitals.consciousness")}
              testID="chart-consciousness"
              value={choice.consciousness ?? null}
              onChange={setChoiceField("consciousness")}
              options={options(CONSCIOUSNESS_LEVELS, "mobile.vitals.consciousnessName", "level")}
              error={errors.consciousness}
            />
            {numberField("temperature", t("mobile.vitals.temperature"), true)}
            {preview?.status === "scored" ? (
              <News2Panel news2={toStoredNews2(preview.result)} />
            ) : preview?.status === "noScale" ? (
              <Text tone="warning" emphasis accessibilityRole="alert" testID="news2-no-scale">
                {t("mobile.news2.noScale")}
              </Text>
            ) : (
              <Text tone="secondary" testID="news2-incomplete">
                {t("mobile.news2.incomplete")}
              </Text>
            )}
          </>
        );
      default:
        return null;
    }
  };

  if (!chart) {
    return (
      <FormScreen
        personId={id}
        title={t("mobile.chart.choose")}
        testID="chart-screen"
        showErrors={false}
        saveFailed={false}
        saving={false}
      >
        <Card title={t("mobile.chart.choose")}>
          {CHART_KINDS.map((kind) => (
            <Button
              key={kind}
              label={t("mobile.chart.name", { chart: kind })}
              variant="secondary"
              onPress={() => setChart(kind)}
              testID={`chart-choose-${kind}`}
            />
          ))}
        </Card>
      </FormScreen>
    );
  }

  return (
    <FormScreen
      personId={id}
      title={t("mobile.chart.name", { chart })}
      testID={`chart-screen-${chart}`}
      showErrors={Object.keys(errors).length > 0}
      saveFailed={saveFailed}
      saving={saving}
      onSave={save}
    >
      {correctId ? (
        <CorrectionField
          original={original ? `${original.title}: ${original.summary}` : ""}
          reason={reason}
          onChange={setReason}
          error={errors.reason}
        />
      ) : null}
      {fields()}
      <WhenField
        value={when}
        onChange={setWhen}
        error={errors.when}
        windowDays={context.windowDays ?? null}
        toleranceMinutes={context.clockToleranceMinutes ?? 0}
        original={correctId ? (originals[0]?.occurred_at ?? null) : null}
      />
      <Card title={t("mobile.chart.recentEntries")}>
        {earlier.length > 0 ? (
          earlier.map((item) => <EntryRow key={item.id} item={item} />)
        ) : (
          <Text variant="bodyDense" testID="chart-no-entries">
            {t("mobile.chart.noEntries")}
          </Text>
        )}
        {vault.offlineWindowDays !== null && !appEnv.demoMode ? (
          <Text variant="bodyDense" tone="secondary" testID="chart-window">
            {t("mobile.sync.window", { days: vault.offlineWindowDays })}
          </Text>
        ) : null}
      </Card>
    </FormScreen>
  );
}
