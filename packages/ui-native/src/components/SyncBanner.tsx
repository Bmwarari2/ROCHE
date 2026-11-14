import { useEffect, useState } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import { describeSyncBanner, type SyncConnectionState } from "../logic/sync-banner";
import { bannerAppearance } from "../logic/theme";
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
  /** Why sync is refused, when the API said (`scope_too_large`, ADR-0134). */
  readonly failureReason?: "scope_too_large" | null;
  /**
   * Speaks a lasting refusal (with any warning beside it) to screen readers. The app passes one
   * that says each text once across every screen's banner; the default speaks it on each change.
   */
  readonly announce?: (text: string) => void;
  /** Shown as a "Retry" action when the state is failed (HZ-006). */
  readonly onRetry?: () => void;
  /** Fixes the clock, for previews and tests. Otherwise the banner refreshes every 30 seconds. */
  readonly now?: Date;
  readonly testID?: string;
}

const REFRESH_MS = 30_000;

function defaultAnnounce(text: string): void {
  AccessibilityInfo.announceForAccessibility?.(text);
}

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
  failureReason = null,
  announce = defaultAnnounce,
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
    failureReason,
  });

  // Warnings and failures are filled so they cannot be missed; calm states sit on the card colour.
  // A refusal lasts until access changes: it is announced, with any stale-data warning beside it
  // (HZ-002), when it or the warning changes, and kept out of the live region, so the
  // minute-by-minute "Last synced" never re-reads it (accessibility review, 2).
  const announcement = content.reason
    ? [`${content.title}.`, content.reason, content.warning].filter(Boolean).join(" ")
    : null;
  useEffect(() => {
    if (announcement) announce(announcement);
  }, [announcement, announce]);

  // Calm states sit on the card colour with a quiet icon; a warning (stale, never synced, access
  // too wide) is filled with the warning colour and a failure with the alarm fill, each with its
  // own text colour, so either stands apart from the page and the calm banner (HZ-002).
  const look = bannerAppearance(content.tone, theme.colors);
  const filled = look.filled;
  const fill = look;
  const background = look.background;
  const iconColour = look.icon;
  const textTone = "primary";
  const detailTone = filled ? "primary" : "secondary";
  const onFill = filled ? { color: fill.foreground } : undefined;
  const Icon = iconByName(content.icon);

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          backgroundColor: background,
          borderBottomColor: look.border ?? theme.colors.border,
          borderTopColor: look.border ?? "transparent",
          borderTopWidth: look.border ? 2 : 0,
          borderBottomWidth: look.border ? 2 : StyleSheet.hairlineWidth,
          paddingHorizontal: theme.space[2],
          paddingVertical: theme.space[1],
          gap: theme.space[1.5],
        },
      ]}
    >
      <View
        accessible
        testID={`${testID}-message`}
        accessibilityRole={content.urgent ? "alert" : "summary"}
        accessibilityLabel={content.accessibilityLabel}
        accessibilityLiveRegion={content.reason ? "none" : content.urgent ? "assertive" : "polite"}
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
          <Text
            variant="bodyDense"
            tone={textTone}
            emphasis
            style={onFill}
            testID={`${testID}-title`}
          >
            {content.title}
          </Text>
          {content.reason ? (
            <Text variant="bodyDense" tone={textTone} style={onFill} testID={`${testID}-reason`}>
              {content.reason}
            </Text>
          ) : null}
          <Text variant="bodyDense" tone={detailTone} style={onFill} testID={`${testID}-detail`}>
            {content.detail}
          </Text>
          {content.warning ? (
            <Text
              variant="bodyDense"
              tone={textTone}
              emphasis
              style={onFill}
              testID={`${testID}-warning`}
            >
              {content.warning}
            </Text>
          ) : null}
        </View>
      </View>
      {content.showRetry && onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry sync"
          accessibilityHint={content.retryHint}
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
              borderColor: filled ? fill.foreground : theme.colors.outline,
              paddingHorizontal: theme.space[2],
              opacity: pressed ? 0.75 : 1,
            },
          ]}
        >
          <Text variant="bodyDense" tone={textTone} emphasis style={onFill}>
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
