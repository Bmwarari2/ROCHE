import { Text, useTheme } from "@harbour/ui-native";
import { forwardRef } from "react";
import { StyleSheet, TextInput, type TextInputProps, View } from "react-native";

interface TextFieldProps extends Omit<TextInputProps, "style"> {
  /** Visible label, also used as the accessibility label. */
  readonly label: string;
  readonly hint?: string;
  readonly errorText?: string | null;
  /** Taller box for multi-line text such as a care note. */
  readonly minHeight?: number;
}

/** Labelled text input: 44 pt minimum height, 17 pt text, visible label and error. */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, hint, errorText, testID, minHeight, ...inputProps },
  ref,
) {
  const theme = useTheme();
  const invalid = Boolean(errorText);
  return (
    <View style={{ gap: theme.space[0.5] }}>
      <Text variant="bodyDense" emphasis nativeID={testID ? `${testID}-label` : undefined}>
        {label}
      </Text>
      <TextInput
        ref={ref}
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityLabelledBy={testID ? `${testID}-label` : undefined}
        placeholderTextColor={theme.colors.textSecondary}
        maxFontSizeMultiplier={2}
        style={[
          styles.input,
          {
            minHeight: Math.max(theme.touchTarget, minHeight ?? 0),
            borderRadius: theme.radius.input,
            borderColor: invalid ? theme.colors.danger : theme.colors.border,
            backgroundColor: theme.colors.card,
            color: theme.colors.text,
            fontSize: theme.type.body.fontSize,
            paddingHorizontal: theme.space[1.5],
            paddingVertical: theme.space[1],
          },
        ]}
        {...inputProps}
      />
      {hint ? (
        <Text variant="bodyDense" tone="secondary">
          {hint}
        </Text>
      ) : null}
      {errorText ? (
        <Text
          variant="bodyDense"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          {errorText}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  input: { borderWidth: 1 },
});
