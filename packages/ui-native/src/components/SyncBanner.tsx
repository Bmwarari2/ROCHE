import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { describeSyncBanner, type SyncConnectionState } from "../logic/sync-banner";
import { toneAppearance } from "../logic/theme";
import { useHaptics, useTheme } from "../theme/ThemeProvider";
import { ICON_STROKE_WIDTH, iconByName } from "./icons";
import { Text } from "./Text";

export interface SyncBannerProps {
  readonly state: SyncConnectionState;
  /** Time of the last successful sync, or null if the device has never synced. */
  readonly lastSyncedAt: Date | null;
  /** Data older than this carries a "may be out of date" warning (HZ-002). */
  readonly staleAfterMs: number;
  readonly queuedChanges?: number;
  /** Entries the server refused: shown on every screen, never "Up to date" (HZ-006, C1). */
  readonly refusedEntries?: number | null;
  /** Shown as a "Retry" action when the state is failed (HZ-006). */
  readonly onRetry?: () => void;
  /** Fixes the clock, for previews and tests. Otherwise the banner refreshes every 30 seconds. */
  readonly now?: Date;
  readonly testID?: string;
}

const REFRESH_MS = 30_000;

function useNow(fixed: Date | undefined): Date {
  const [now, setNow] = useState(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed) {
      setNow(fixed);
      return;
    }
    const timer = setInterval(() => setNow(new Date()), REFRESH_MS);
    return () => clearInterval(timer);
  }, [fixed]);
  return now;
}

/**
 * Sync status shown on every screen: offline, syncing, up to date, or failed with a retry, plus
 * an explicit warning when the data on the device may be out of date.
 */
export function SyncBanner({
  state,
  lastSyncedAt,
  staleAfterMs,
  queuedChanges = 0,
  refusedEntries = 0,
  onRetry,
  now: fixedNow,
  testID = "sync-banner",
}: SyncBannerProps) {
  const theme = useTheme();
  const haptics = useHaptics();
  const now = useNow(fixedNow);
  const content = describeSyncBanner({
    state,
    lastSyncedAt,
    now,
    staleAfterMs,
    queuedChanges,
    refusedEntries,
  });

  // Warnings and failures are filled so they cannot be missed; calm states sit on the card colour.
  const filled = content.tone === "warning" || content.tone === "danger";
  const fill = toneAppearance(content.tone);
  const background = filled ? fill.background : theme.colors.card;
  const iconColour = filled ? fill.foreground : fill.background;
  const textTone = filled ? "onAccent" : "primary";
  const detailTone = filled ? "onAccent" : "secondary";
  const Icon = iconByName(content.icon);

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          backgroundColor: background,
          borderBottomColor: theme.colors.border,
          paddingHorizontal: theme.space[2],
          paddingVertical: theme.space[1],
          gap: theme.space[1.5],
        },
      ]}
    >
      <View
        accessible
        accessibilityRole={content.urgent ? "alert" : "summary"}
        accessibilityLabel={content.accessibilityLabel}
        accessibilityLiveRegion={content.urgent ? "assertive" : "polite"}
        style={styles.message}
      >
        <Icon
          color={iconColour}
          size={20}
          strokeWidth={ICON_STROKE_WIDTH + 0.5}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <View style={styles.text}>
          <Text variant="bodyDense" tone={textTone} emphasis testID={`${testID}-title`}>
            {content.title}
          </Text>
          <Text variant="bodyDense" tone={detailTone} testID={`${testID}-detail`}>
            {content.detail}
          </Text>
          {content.warning ? (
            <Text variant="bodyDense" tone={textTone} emphasis testID={`${testID}-warning`}>
              {content.warning}
            </Text>
          ) : null}
        </View>
      </View>
      {content.showRetry && onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry sync"
          accessibilityHint="Tries to connect and sync again"
          testID={`${testID}-retry`}
          onPress={() => {
            haptics?.selection();
            onRetry();
          }}
          hitSlop={8}
          style={({ pressed }) => [
            styles.retry,
            {
              minHeight: theme.touchTarget,
              minWidth: theme.touchTarget,
              borderRadius: theme.radius.pill,
              borderColor: fill.foreground,
              paddingHorizontal: theme.space[2],
              opacity: pressed ? 0.75 : 1,
            },
          ]}
        >
          <Text variant="bodyDense" tone={textTone} emphasis>
            Retry
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  message: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 8 },
  text: { flex: 1 },
  retry: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
});
