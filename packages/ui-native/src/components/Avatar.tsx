import { useEffect, useState } from "react";
import { Image, type ImageURISource, StyleSheet, View } from "react-native";
import { initialsFor, type PersonNameParts } from "../logic/person";
import { useTheme } from "../theme/ThemeProvider";
import { ICON_STROKE_WIDTH, User } from "./icons";
import { Text } from "./Text";

export interface AvatarProps {
  /** Photo source (may carry auth headers). Falls back to initials when missing or failing. */
  readonly photo?: ImageURISource | null;
  readonly name: PersonNameParts;
  readonly size?: number;
  readonly testID?: string;
}

/**
 * Person photo with an initials fallback. Decorative for assistive technology: the name next to
 * it is always read instead, so the avatar never becomes the only identifier.
 */
export function Avatar({ photo, name, size = 48, testID }: AvatarProps) {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const uri = photo?.uri;

  useEffect(() => {
    // A new photo URI deserves a fresh attempt.
    if (uri) setFailed(false);
  }, [uri]);

  const frame = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: theme.colors.bgSecondary,
    borderColor: theme.colors.border,
  };

  if (photo?.uri && !failed) {
    return (
      <Image
        testID={testID}
        source={photo}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[styles.frame, frame]}
      />
    );
  }

  const initials = initialsFor(name);
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.frame, styles.centre, frame]}
    >
      {initials ? (
        <Text
          variant={size >= 64 ? "eyebrow" : "body"}
          emphasis
          tone="secondary"
          maxFontSizeMultiplier={1}
        >
          {initials}
        </Text>
      ) : (
        <User color={theme.colors.textSecondary} size={size / 2} strokeWidth={ICON_STROKE_WIDTH} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  centre: { alignItems: "center", justifyContent: "center" },
});
