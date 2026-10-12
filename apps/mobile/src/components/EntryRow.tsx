import { FlagChip, iconByName, Text, useTheme } from "@harbour/ui-native";
import { Pressable, View } from "react-native";
import { news2Appearance } from "../care/charts";
import { ENTRY_STATUS_APPEARANCE } from "../care/entries";
import type { EntryItem } from "../care/entry-view";
import { t } from "../i18n/t";

interface EntryRowProps {
  readonly item: EntryItem;
  /** Opens the correction form for this entry. */
  readonly onCorrect?: (item: EntryItem) => void;
}

/**
 * One entry in a list: what and when, a summary, and its state as icon plus words: waiting to
 * upload or saved (HZ-002, HZ-006), late entry (HZ-017), device clock wrong (HZ-010), and the
 * NEWS2 score where there is one. Corrections say what they correct and why.
 */
export function EntryRow({ item, onCorrect }: EntryRowProps) {
  const theme = useTheme();
  const status = ENTRY_STATUS_APPEARANCE[item.status];
  const news2 = item.news2 ? news2Appearance(item.news2) : null;
  return (
    <View
      testID={`entry-${item.id}`}
      style={{
        gap: theme.space[1],
        paddingVertical: theme.space[1.5],
        borderBottomColor: theme.colors.border,
        borderBottomWidth: 1,
      }}
    >
      <View accessible style={{ gap: theme.space[0.5] }}>
        <Text emphasis>{item.title}</Text>
        <Text variant="bodyDense" tone="secondary">
          {item.when}
        </Text>
        <Text>{item.summary}</Text>
        {item.correction ? (
          <Text variant="bodyDense" tone="secondary">
            {item.correction}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[1] }}>
        <FlagChip
          tone={status.tone}
          icon={iconByName(status.icon)}
          label={t("mobile.entry.status", { status: item.status })}
          testID={`entry-${item.id}-status`}
        />
        {news2 && item.news2 ? (
          <FlagChip
            tone={news2.tone}
            icon={iconByName(news2.icon)}
            label={t("mobile.news2.title", { score: item.news2.score })}
          />
        ) : null}
        {item.late ? (
          <FlagChip tone="warning" icon={iconByName("clock")} label={t("mobile.entry.late")} />
        ) : null}
        {item.clockDrift ? (
          <FlagChip
            tone="warning"
            icon={iconByName("triangle-alert")}
            label={t("mobile.entry.clockDrift")}
          />
        ) : null}
      </View>
      {onCorrect ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onCorrect(item)}
          testID={`entry-${item.id}-correct`}
          style={{
            minHeight: theme.touchTarget,
            justifyContent: "center",
            alignSelf: "flex-start",
          }}
        >
          <Text tone="link" emphasis>
            {t("mobile.entry.correct")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
