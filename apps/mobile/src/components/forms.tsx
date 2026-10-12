/**
 * Form controls for Care mode: radio groups whose selected option is shown with a word as well as
 * a border (never colour alone), 44 pt targets, visible labels and errors announced to screen
 * readers. Words come from the catalogue through the callers.
 */
import { Text, useTheme } from "@harbour/ui-native";
import { Pressable, View } from "react-native";
import { CORRECTION_REASON_LIMITS, type FieldError } from "../care/entries";
import {
  ambiguousTime,
  maxDaysBack,
  parseClockTime,
  parseInstant,
  resolveOccurredAt,
  type UkZone,
  ukDateLabel,
  ukDateTimeParts,
  type WhenChoice,
} from "../care/time";
import { t } from "../i18n/t";
import { TextField } from "./TextField";

export function errorText(error: FieldError | null | undefined): string | null {
  return error ? t(error.key, error.values) : null;
}

export function FieldMessage({ error }: { readonly error: FieldError | null | undefined }) {
  const text = errorText(error);
  if (!text) return null;
  return (
    <Text
      variant="bodyDense"
      tone="danger"
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      {text}
    </Text>
  );
}

export interface ChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** A second line, for example the published description of a Bristol stool type. */
  readonly detail?: string | null;
}

interface ChoiceGroupProps<T extends string> {
  readonly label: string;
  readonly options: readonly ChoiceOption<T>[];
  readonly value: T | null;
  readonly onChange: (value: T) => void;
  readonly error?: FieldError | null;
  readonly hint?: string | null;
  readonly testID: string;
}

/** One choice from a list, with radio semantics. */
export function ChoiceGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  error,
  hint,
  testID,
}: ChoiceGroupProps<T>) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[1] }} accessibilityRole="radiogroup" testID={testID}>
      <Text variant="bodyDense" emphasis accessibilityRole="header">
        {label}
      </Text>
      {hint ? (
        <Text variant="bodyDense" tone="secondary">
          {hint}
        </Text>
      ) : null}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`${testID}-${option.value}`}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={option.detail ? `${option.label}. ${option.detail}` : option.label}
            onPress={() => onChange(option.value)}
            style={{
              minHeight: theme.touchTarget,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: theme.space[1],
              borderRadius: theme.radius.input,
              borderWidth: selected ? 2 : 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: theme.colors.card,
              paddingHorizontal: theme.space[1.5],
              paddingVertical: theme.space[1],
            }}
          >
            <View style={{ flex: 1 }}>
              <Text emphasis={selected}>{option.label}</Text>
              {option.detail ? (
                <Text variant="bodyDense" tone="secondary">
                  {option.detail}
                </Text>
              ) : null}
            </View>
            {selected ? (
              <Text tone="accent" emphasis>
                {t("mobile.common.selected")}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
      <FieldMessage error={error} />
    </View>
  );
}

interface YesNoProps {
  readonly label: string;
  readonly value: boolean | null;
  readonly onChange: (value: boolean) => void;
  readonly error?: FieldError | null;
  readonly testID: string;
}

/** A yes or no question, answered explicitly (no default). */
export function YesNoField({ label, value, onChange, error, testID }: YesNoProps) {
  return (
    <ChoiceGroup
      label={label}
      testID={testID}
      value={value === null ? null : value ? "yes" : "no"}
      onChange={(choice) => onChange(choice === "yes")}
      options={[
        { value: "yes", label: t("mobile.common.yes") },
        { value: "no", label: t("mobile.common.no") },
      ]}
      error={error}
    />
  );
}

interface WhenFieldProps {
  readonly value: WhenChoice;
  readonly onChange: (value: WhenChoice) => void;
  readonly error?: FieldError | null;
  /** Days of entries the device keeps (`mobile.offline_window_days`): how far back a day goes. */
  readonly windowDays: number | null;
  /** Minutes ahead of the device clock still accepted (`sync.clock_drift_flag_minutes`). */
  readonly toleranceMinutes: number;
  /** When correcting, the original entry's event time, offered first and chosen by default. */
  readonly original?: string | null;
  /** The current time; the device clock unless a test fixes it. */
  readonly now?: Date;
}

/** A typed time written the way it is shown everywhere else: two-digit hours ("01:30"). */
export function normalisedTime(value: string): string {
  const parsed = parseClockTime(value);
  if (!parsed) return value.trim();
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

/**
 * When the care happened (HZ-009, HZ-010, HZ-017; clinical reviews C4 and round 3 H1): now, a time
 * on a day the carer chooses within the offline window (today unless they choose another), or, for
 * a correction, the original entry's time. A time later than now is refused, never moved to
 * yesterday. In the repeated autumn hour, once both have passed, the carer chooses BST or GMT, with
 * no default. The field says which date and time will be recorded, with BST or GMT on a
 * clock-change day.
 */
export function WhenField({
  value,
  onChange,
  error,
  windowDays,
  toleranceMinutes,
  original,
  now: fixedNow,
}: WhenFieldProps) {
  const theme = useTheme();
  const now = fixedNow ?? new Date();
  const originalAt = original ? parseInstant(original) : null;
  const daysBack = maxDaysBack(windowDays);
  const day = value.kind === "earlier" ? (value.daysAgo ?? 0) : 0;
  const zone = value.kind === "earlier" ? (value.zone ?? null) : null;
  const resolved =
    value.kind === "earlier" ? resolveOccurredAt(value, now, windowDays, toleranceMinutes) : null;
  const twice = ambiguousTime(value, now, windowDays, toleranceMinutes);
  const shownTime = value.kind === "earlier" ? normalisedTime(value.time) : "";

  const dayLabel = (daysAgo: number) => {
    const date = ukDateLabel(now, daysAgo);
    if (daysAgo === 0) return t("mobile.when.dayToday", { date });
    if (daysAgo === 1) return t("mobile.when.dayYesterday", { date });
    return t("mobile.when.dayOn", { date });
  };

  return (
    <View style={{ gap: theme.space[1] }}>
      <ChoiceGroup
        label={t("mobile.when.label")}
        testID="when"
        value={value.kind}
        onChange={(kind) => {
          if (kind === "now") onChange({ kind });
          else if (kind === "original" && original) onChange({ kind, at: original });
          else
            onChange({
              kind: "earlier",
              time: value.kind === "earlier" ? value.time : "",
              daysAgo: 0,
            });
        }}
        options={[
          ...(originalAt && original
            ? [
                {
                  value: "original" as const,
                  label: t("mobile.when.original", ukDateTimeParts(originalAt)),
                },
              ]
            : []),
          { value: "now" as const, label: t("mobile.when.now") },
          { value: "earlier" as const, label: t("mobile.when.earlier") },
        ]}
      />
      {value.kind === "earlier" ? (
        <>
          <ChoiceGroup
            label={t("mobile.when.day")}
            testID="when-day"
            value={String(day)}
            onChange={(choice) =>
              onChange({ kind: "earlier", time: value.time, daysAgo: Number(choice), zone: null })
            }
            options={Array.from({ length: daysBack + 1 }, (_, daysAgo) => ({
              value: String(daysAgo),
              label: dayLabel(daysAgo),
            }))}
          />
          <TextField
            label={t("mobile.when.time")}
            hint={t("mobile.when.timeHint")}
            value={value.time}
            onChangeText={(time) => onChange({ kind: "earlier", time, daysAgo: day, zone: null })}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            errorText={errorText(error)}
            testID="when-time"
          />
          {twice ? (
            <ChoiceGroup<UkZone>
              label={t("mobile.when.zoneLabel", { time: shownTime })}
              hint={t("mobile.when.zoneHint")}
              testID="when-zone"
              value={zone}
              onChange={(next) =>
                onChange({
                  kind: "earlier",
                  time: value.kind === "earlier" ? value.time : "",
                  daysAgo: day,
                  zone: next,
                })
              }
              // Each option names the time with its zone (clinical review round 4, low).
              options={[
                { value: "BST", label: t("mobile.when.zoneBst", { time: shownTime }) },
                { value: "GMT", label: t("mobile.when.zoneGmt", { time: shownTime }) },
              ]}
            />
          ) : null}
          {resolved?.ok ? (
            <Text variant="bodyDense" emphasis testID="when-resolved">
              {t("mobile.when.resolved", ukDateTimeParts(resolved.occurredAt))}
            </Text>
          ) : null}
        </>
      ) : (
        <FieldMessage error={error} />
      )}
    </View>
  );
}

interface CorrectionFieldProps {
  readonly original: string;
  readonly reason: string;
  readonly onChange: (reason: string) => void;
  readonly error?: FieldError | null;
}

/** Shown when correcting: what is being corrected, and why (HZ-017). */
export function CorrectionField({ original, reason, onChange, error }: CorrectionFieldProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[1] }} testID="correction">
      <Text variant="bodyDense" emphasis accessibilityRole="header">
        {t("mobile.correction.title")}
      </Text>
      <Text variant="bodyDense" tone="secondary">
        {t("mobile.correction.original", { summary: original })}
      </Text>
      <TextField
        label={t("mobile.correction.reason")}
        hint={t("mobile.correction.reasonHint")}
        value={reason}
        onChangeText={onChange}
        multiline
        maxLength={CORRECTION_REASON_LIMITS.max}
        errorText={errorText(error)}
        testID="correction-reason"
      />
    </View>
  );
}
