import { Text as RNText, type TextProps as RNTextProps, StyleSheet } from "react-native";
import type { TextTone, TypeVariant } from "../logic/theme";
import { useTheme } from "../theme/ThemeProvider";

export type { TextTone };

export interface TextProps extends RNTextProps {
  /** A type-scale token. Native sizes never go below 15. Defaults to body. */
  readonly variant?: TypeVariant;
  readonly tone?: TextTone;
  /** Semibold emphasis without changing size. */
  readonly emphasis?: boolean;
}

/** Dynamic type is honoured up to 200% (WCAG 2.2 resize text). */
const MAX_FONT_SCALE = 2;

export function Text({
  variant = "body",
  tone = "primary",
  emphasis = false,
  style,
  maxFontSizeMultiplier = MAX_FONT_SCALE,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const type = theme.type[variant];
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[
        styles.base,
        {
          color: theme.textColors[tone],
          fontSize: type.fontSize,
          lineHeight: type.lineHeight,
          fontWeight: emphasis ? "600" : type.fontWeight,
          letterSpacing: type.letterSpacing,
        },
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  base: { includeFontPadding: false },
});
