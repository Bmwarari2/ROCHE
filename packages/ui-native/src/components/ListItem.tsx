import { nativeMetrics } from "@harbour/ui/tokens";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import PanelRight from "lucide-react-native/icons/panel-right";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { selectionColors, withAlpha } from "../logic/theme";
import { useHaptics, useTheme } from "../theme/ThemeProvider";
import { ICON_STROKE_WIDTH } from "./icons";
import { useListPosition } from "./ListSection";
import { Text } from "./Text";

export interface ListItemProps {
  readonly title: string;
  readonly subtitle?: string | null;
  /** Avatar or icon on the leading edge; hidden from assistive technology. */
  readonly leading?: ReactNode;
  /** Extra content under the subtitle, such as flags. */
  readonly accessories?: ReactNode;
  readonly onPress?: () => void;
  /** Read as one unit. Defaults to the title and subtitle. */
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly showChevron?: boolean;
  /**
   * The row whose detail is open beside the list on a tablet (MOB-013). Said in words with an icon
   * (`selectedLabel`), marked by a bar on the leading edge, and announced as selected: never by
   * colour alone.
   */
  readonly selected?: boolean;
  /** Words shown and read on the selected row, such as "Shown on the right". */
  readonly selectedLabel?: string;
  /** The width of the leading element, so the iOS divider starts at the text. Defaults to 40. */
  readonly leadingSize?: number;
  readonly testID?: string;
}

/**
 * A tappable row at least the platform's touch target tall, read by screen readers as a single
 * button (ADR-0138). In a `ListSection` it takes the group's look: an inset divider between rows on
 * iOS, none between Material 3's segmented rows on Android. On Android a press shows the ripple; on
 * iOS the row highlights.
 */
export function ListItem({
  title,
  subtitle,
  leading,
  accessories,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  showChevron = onPress !== undefined,
  selected = false,
  selectedLabel,
  leadingSize = nativeMetrics.leadingSize,
  testID,
}: ListItemProps) {
  const theme = useTheme();
  const haptics = useHaptics();
  // The selected state is said once, by the platform ("selected"), not again in the label; the
  // words on the row are for sighted readers (#73 accessibility review L7).
  const label = accessibilityLabel ?? [title, subtitle].filter(Boolean).join(", ");
  // At large text the title and subtitle wrap as far as they need, never cut off (WCAG 1.4.4).
  const { fontScale } = useWindowDimensions();
  const lines = fontScale > LARGE_TEXT_SCALE ? undefined : 2;
  const android = theme.platform === "android";
  const position = useListPosition();
  // iOS draws a hairline between rows, inset to the text. Material 3's segmented rows need none,
  // but a row outside a group still needs a line under it, so rows never merge (review H2).
  const divider = android ? position === null : !(position?.last ?? false);
  const leadingWidth = leading ? leadingSize + theme.space[1.5] : 0;
  // Every word on a selected row takes the selection's own text colour (accessibility review B1).
  const selection = selectionColors(theme.colors);
  const onSelected = selected ? { color: selection.text } : undefined;
  // A visible focus ring for a keyboard or switch user (accessibility review M1).
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      testID={testID}
      accessible
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      accessibilityHint={selected ? undefined : accessibilityHint}
      accessibilityState={onPress ? { selected } : undefined}
      disabled={!onPress}
      onPress={
        onPress
          ? () => {
              haptics?.selection();
              onPress();
            }
          : undefined
      }
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      android_ripple={
        android && onPress ? { color: withAlpha(theme.colors.text, RIPPLE_OPACITY) } : undefined
      }
      style={({ pressed }) => [
        styles.row,
        accessories ? styles.rowTop : null,
        {
          minHeight: Math.max(
            theme.touchTarget,
            subtitle && android ? nativeMetrics.twoLineRowAndroid : 0,
          ),
          paddingHorizontal: theme.space[2],
          paddingVertical: android ? theme.space[1.5] : nativeMetrics.rowPaddingYIos,
          gap: theme.space[1.5],
          backgroundColor: selected
            ? selection.background
            : pressed && !android
              ? theme.colors.pressed
              : theme.colors.card,
          borderLeftWidth: SELECTED_BAR,
          borderLeftColor: selected ? theme.colors.accent : "transparent",
        },
      ]}
    >
      {leading ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {leading}
        </View>
      ) : null}
      <View style={[styles.body, { gap: theme.space[0.5] }]}>
        <Text emphasis numberOfLines={lines} style={onSelected}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodyDense" tone="secondary" numberOfLines={lines} style={onSelected}>
            {subtitle}
          </Text>
        ) : null}
        {accessories}
        {selected && selectedLabel ? (
          <View
            style={[styles.selected, { gap: theme.space[0.5] }]}
            testID={testID ? `${testID}-selected` : undefined}
          >
            <PanelRight
              color={selection.text}
              size={18}
              strokeWidth={ICON_STROKE_WIDTH}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
            <Text variant="bodyDense" emphasis style={onSelected}>
              {selectedLabel}
            </Text>
          </View>
        ) : null}
      </View>
      {showChevron ? (
        <ChevronRight
          style={styles.chevron}
          color={
            selected
              ? selection.text
              : android
                ? theme.colors.textSecondary
                : theme.colors.textTertiary
          }
          size={android ? 24 : 18}
          strokeWidth={android ? ICON_STROKE_WIDTH : 2}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : null}
      {focused ? (
        <View
          pointerEvents="none"
          style={[
            styles.focus,
            { borderColor: theme.colors.accent, borderWidth: nativeMetrics.focusOutline },
          ]}
        />
      ) : null}
      {divider ? (
        <View
          pointerEvents="none"
          style={[
            styles.divider,
            {
              left: android ? 0 : theme.space[2] + SELECTED_BAR + leadingWidth,
              backgroundColor: theme.colors.border,
            },
          ]}
        />
      ) : null}
    </Pressable>
  );
}

/** Above this text size a row's lines are never limited. */
const LARGE_TEXT_SCALE = 1.3;

/** The leading bar on the selected row, in points; always drawn so the row never shifts. */
const SELECTED_BAR = 4;

/** Material 3's pressed state layer: the text colour at 12%. */
const RIPPLE_OPACITY = 0.12;

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  /** A row with flags under its text keeps its avatar level with the name. */
  rowTop: { alignItems: "flex-start" },
  chevron: { alignSelf: "center" },
  focus: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  divider: {
    position: "absolute",
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  body: { flex: 1 },
  selected: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
});
