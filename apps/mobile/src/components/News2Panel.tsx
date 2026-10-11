import { FlagChip, iconByName, Text, useTheme } from "@harbour/ui-native";
import { View } from "react-native";
import { news2Appearance, type StoredNews2 } from "../care/charts";
import { t } from "../i18n/t";

/**
 * The NEWS2 result as the carer types (HZ-012, HZ-014): the score and the RCP's clinical risk,
 * response and monitoring wording unchanged, every parameter's points (the workings), and the
 * tenant's escalation policy. Harbour adds no advice of its own (medical-device boundary).
 */
export function News2Panel({ news2 }: { readonly news2: StoredNews2 }) {
  const theme = useTheme();
  const appearance = news2Appearance(news2);
  return (
    <View
      testID="news2-result"
      accessibilityLiveRegion={appearance.raised ? "assertive" : "polite"}
      style={{
        gap: theme.space[1],
        padding: theme.space[1.5],
        borderRadius: theme.radius.card,
        borderWidth: appearance.raised ? 2 : 1,
        borderColor: appearance.raised ? theme.colors.danger : theme.colors.border,
        backgroundColor: theme.colors.card,
      }}
    >
      <FlagChip
        tone={appearance.tone}
        icon={iconByName(appearance.icon)}
        label={t("mobile.news2.title", { score: news2.score })}
        testID="news2-score"
      />
      <Text emphasis>{t("mobile.news2.risk", { risk: news2.clinicalRisk })}</Text>
      <Text>{t("mobile.news2.response", { response: news2.response })}</Text>
      <Text>{t("mobile.news2.monitoring", { monitoring: news2.monitoring })}</Text>
      {news2.redScore ? <Text emphasis>{t("mobile.news2.redScore")}</Text> : null}
      <View accessible style={{ gap: theme.space[0.5] }}>
        {news2.workings.map((w) => (
          <Text key={w.item} variant="bodyDense" tone="secondary">
            {t("mobile.news2.working", { item: w.item, value: w.value, points: w.points })}
          </Text>
        ))}
      </View>
      <Text variant="bodyDense" emphasis>
        {t("mobile.news2.policy")}
      </Text>
      <Text variant="bodyDense" tone="secondary">
        {t("mobile.news2.source", { version: news2.toolVersion })}
      </Text>
    </View>
  );
}
