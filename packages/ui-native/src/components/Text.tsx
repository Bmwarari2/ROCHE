import {
  Text as RNText,
  type TextProps as RNTextProps,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import type { TextTone, TypeVariant } from "../logic/theme";
import { useTheme } from "../theme/ThemeProvider";

export type { TextTone };

export interface TextProps extends RNTextProps {
  /** A type-scale token. Native sizes never go below 15. Defaults to body. */
  readonly variant?: TypeVariant;
  readonly tone?: TextTone;
  /** Emphasis without changing size: semibold on iOS, medium on Android. */
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
  // When the system text size changes while the app is open, iOS kept some text at its old size
  // and some blank until a relaunch (iOS device check, 14/11/2026). Drawing the text afresh at
  // each text size makes it measure again; a text holds no state, so nothing is lost.
  const { fontScale } = useWindowDimensions();
  return (
    <RNText
      key={fontScale}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[
        styles.base,
        {
          color: theme.textColors[tone],
          fontSize: type.fontSize,
          lineHeight: type.lineHeight,
          fontWeight: emphasis ? theme.emphasisWeight : type.fontWeight,
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
