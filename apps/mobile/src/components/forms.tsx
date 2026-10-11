/**
 * Form controls for Care mode: radio groups whose selected option is shown with a word as well as
 * a border (never colour alone), 44 pt targets, visible labels and errors announced to screen
 * readers. Words come from the catalogue through the callers.
 */
import { Text, useTheme } from "@harbour/ui-native";
import { Pressable, View } from "react-native";
import { CORRECTION_REASON_LIMITS, type FieldError } from "../care/entries";
import type { WhenChoice } from "../care/time";
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
}

/** When the care happened: now, or a time earlier today (HZ-017). */
export function WhenField({ value, onChange, error }: WhenFieldProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[1] }}>
      <ChoiceGroup
        label={t("mobile.when.label")}
        testID="when"
        value={value.kind}
        onChange={(kind) =>
          onChange(
            kind === "now" ? { kind } : { kind, time: value.kind === "earlier" ? value.time : "" },
          )
        }
        options={[
          { value: "now", label: t("mobile.when.now") },
          { value: "earlier", label: t("mobile.when.earlier") },
        ]}
      />
      {value.kind === "earlier" ? (
        <TextField
          label={t("mobile.when.time")}
          hint={t("mobile.when.timeHint")}
          value={value.time}
          onChangeText={(time) => onChange({ kind: "earlier", time })}
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          errorText={errorText(error)}
          testID="when-time"
        />
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
