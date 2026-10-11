import { Text } from "@harbour/ui-native";
import type { EntryItem } from "../care/entry-view";
import { t } from "../i18n/t";
import { Card } from "./Card";
import { EntryRow } from "./EntryRow";

/**
 * A chart's recent entries on the device, and how many days the device keeps (HZ-028; clinical
 * review C9): the line about the days shows even when the chart has no entries here, so an empty
 * chart is never read as nothing having been recorded.
 */
export function ChartEntries({
  items,
  windowDays,
}: {
  readonly items: readonly EntryItem[];
  /** Days of entries kept on the device, once known; null hides the line (and in demo mode). */
  readonly windowDays: number | null;
}) {
  return (
    <Card title={t("mobile.chart.recentEntries")} testID="chart-entries">
      {items.length > 0 ? (
        items.map((item) => <EntryRow key={item.id} item={item} />)
      ) : (
        <Text variant="bodyDense" testID="chart-no-entries">
          {t("mobile.chart.noEntries")}
        </Text>
      )}
      {windowDays !== null ? (
        <Text variant="bodyDense" tone="secondary" testID="chart-window">
          {t("mobile.sync.window", { days: windowDays })}
        </Text>
      ) : null}
    </Card>
  );
}
