import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { type SplitLayout, splitLayout } from "../logic/split-layout";
import { useTheme } from "../theme/ThemeProvider";
import { Text } from "./Text";

/** The layout for the window as it is now: it follows rotation, window resizing and text size. */
export function useSplitLayout(): SplitLayout {
  const { width, height, fontScale } = useWindowDimensions();
  return useMemo(() => splitLayout({ width, height, fontScale }), [width, height, fontScale]);
}

export interface SplitViewProps {
  /** The list pane's width, from `splitLayout`; the detail pane takes the rest. */
  readonly listWidth: number;
  readonly list: ReactNode;
  readonly detail: ReactNode;
  /**
   * The detail pane's heading, read first in that pane: who or what it shows (for a person, their
   * name, before the point-of-care header; HZ-001). Null when nothing is chosen yet.
   */
  readonly detailTitle: string | null;
  /**
   * Identifies what the detail pane shows. When it changes (the reader chose another row), the
   * screen reader moves to the detail pane's heading, so it never reads on in the list believing
   * the detail has changed when it has not, or the other way round.
   */
  readonly detailKey: string | null;
  readonly testID?: string;
}

/**
 * The list and its detail side by side on a tablet in landscape (MOB-013, master prompt 17.4). The
 * list comes first in the tree, so swipe and keyboard order go through the list, then the detail.
 * Screens decide with `splitLayout` whether to use it; on a phone, in portrait and at text sizes
 * where both panes would not fit, they keep their single pane.
 */
export function SplitView({
  listWidth,
  list,
  detail,
  detailTitle,
  detailKey,
  testID,
}: SplitViewProps) {
  const theme = useTheme();
  const heading = useRef<View>(null);
  const shown = useRef<string | null>(detailKey);
  // A new choice waits here until its heading is drawn, so focus never lands on nothing or on a
  // heading still naming the previous choice (#73 accessibility review H1).
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (detailKey !== shown.current) {
      shown.current = detailKey;
      pending.current = detailKey;
    }
    if (pending.current === null || pending.current !== detailKey || !detailTitle) return;
    // After the detail has drawn, so the heading exists to take the focus.
    const timer = setTimeout(() => {
      pending.current = null;
      try {
        const node = heading.current ? findNodeHandle(heading.current) : null;
        if (node) AccessibilityInfo.setAccessibilityFocus(node);
      } catch {
        // No native view to focus (tests, or the pane unmounted): the order alone still holds.
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [detailKey, detailTitle]);

  return (
    <View testID={testID} style={styles.row}>
      <View
        testID={testID ? `${testID}-list` : undefined}
        style={[styles.list, { width: listWidth, borderRightColor: theme.colors.border }]}
      >
        {list}
      </View>
      <View testID={testID ? `${testID}-detail` : undefined} style={styles.detail}>
        {detailTitle ? (
          <View
            ref={heading}
            accessible
            accessibilityRole="header"
            accessibilityLabel={detailTitle}
            testID={testID ? `${testID}-detail-title` : undefined}
            style={{
              paddingHorizontal: theme.space[2],
              paddingTop: theme.space[2],
              minHeight: theme.touchTarget,
              justifyContent: "flex-end",
            }}
          >
            <Text variant="eyebrow" tone="secondary">
              {detailTitle}
            </Text>
          </View>
        ) : null}
        <View style={styles.detailBody}>{detail}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  list: { borderRightWidth: StyleSheet.hairlineWidth },
  detail: { flex: 1 },
  detailBody: { flex: 1 },
});
