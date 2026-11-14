import { nativeMetrics, Text, useTheme } from "@harbour/ui-native";
import { forwardRef, useState } from "react";
import { StyleSheet, TextInput, type TextInputProps, View } from "react-native";

interface TextFieldProps extends Omit<TextInputProps, "style"> {
  /** Visible label, also used as the accessibility label. */
  readonly label: string;
  readonly hint?: string;
  readonly errorText?: string | null;
  /** Taller box for multi-line text such as a care note. */
  readonly minHeight?: number;
}

/**
 * Labelled text input with a visible label, hint and error (ADR-0138): a Material 3 outlined field
 * on Android (56 dp, small corners, a 2 dp brand outline while focused); on iOS a rounded field
 * filled with the cell colour, outlined in the brand tint while focused. The label sits above the
 * field on both, so it never moves or hides.
 */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, hint, errorText, testID, minHeight, ...inputProps },
  ref,
) {
  const theme = useTheme();
  const invalid = Boolean(errorText);
  const android = theme.platform === "android";
  const [focused, setFocused] = useState(false);
  const { onFocus, onBlur } = inputProps;
  return (
    <View style={{ gap: theme.space[0.5] }}>
      <Text
        variant="bodyDense"
        emphasis
        tone={android ? "secondary" : "primary"}
        nativeID={testID ? `${testID}-label` : undefined}
      >
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
        {...inputProps}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          styles.input,
          {
            minHeight: Math.max(
              android ? nativeMetrics.fieldHeightAndroid : theme.touchTarget,
              minHeight ?? 0,
            ),
            borderRadius: theme.radius.input,
            // The field's edge: an outline at 3:1 on both platforms (WCAG 1.4.11); red on an
            // error, which the words below also say. Focus thickens it to 2 pt in the brand
            // colour, and to 3 pt on a field in error, so focus always shows (review M1).
            borderWidth:
              focused && invalid
                ? 3
                : focused || invalid
                  ? nativeMetrics.focusOutline
                  : nativeMetrics.outline,
            borderColor: invalid
              ? theme.colors.danger
              : focused
                ? theme.colors.accent
                : theme.colors.outline,
            backgroundColor: android ? theme.colors.bg : theme.colors.card,
            color: theme.colors.text,
            fontSize: theme.type.body.fontSize,
            paddingHorizontal: theme.space[2],
            paddingVertical: theme.space[1.5],
            textAlignVertical: inputProps.multiline ? "top" : "center",
          },
        ]}
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
  input: { includeFontPadding: false },
});
