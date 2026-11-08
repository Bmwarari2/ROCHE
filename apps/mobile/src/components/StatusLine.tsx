import { Text, useTheme } from "@harbour/ui-native";
import CircleCheck from "lucide-react-native/icons/circle-check";
import OctagonX from "lucide-react-native/icons/octagon-x";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { View } from "react-native";

const ICONS = { success: CircleCheck, danger: OctagonX, warning: TriangleAlert } as const;

/** A status in words with its icon, never colour alone (section 5.4; WCAG 1.4.1). */
export function StatusLine({
  tone,
  children,
  testID,
}: {
  readonly tone: keyof typeof ICONS;
  readonly children: string;
  readonly testID?: string;
}) {
  const theme = useTheme();
  const Icon = ICONS[tone];
  return (
    <View
      style={{ flexDirection: "row", gap: theme.space[1], alignItems: "flex-start" }}
      testID={testID}
    >
      <Icon
        color={theme.colors[tone]}
        size={20}
        strokeWidth={1.5}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text tone={tone} style={{ flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}
