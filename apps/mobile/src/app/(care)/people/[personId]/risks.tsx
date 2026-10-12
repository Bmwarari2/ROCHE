import { ukIsoDate } from "@harbour/domain";
import { Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { useTenantId } from "../../../../care/hooks";
import {
  ASSESSMENTS_SQL,
  type AssessmentRow,
  RISKS_SQL,
  type RiskRow,
} from "../../../../care/queries";
import { latestAssessments, riskView } from "../../../../care/records";
import { Card } from "../../../../components/Card";
import { CarePersonHeader } from "../../../../components/CarePersonHeader";
import { Screen } from "../../../../components/Screen";
import { t } from "../../../../i18n/t";
import { useRecordScreenProtection } from "../../../../security/use-record-protection";

/** Current risk assessments and the latest validated-tool results, read only (care.md section 6). */
export default function RisksScreen() {
  useRecordScreenProtection("risks");
  const theme = useTheme();
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const id = typeof personId === "string" ? personId : "";
  const tenantId = useTenantId();
  const params = useMemo(() => [tenantId, id], [tenantId, id]);
  const { data: riskRows } = useQuery<RiskRow>(RISKS_SQL, params);
  const { data: assessmentRows } = useQuery<AssessmentRow>(ASSESSMENTS_SQL, params);
  const today = ukIsoDate(new Date());
  const risks = useMemo(() => riskRows.map((r) => riskView(r, today)), [riskRows, today]);
  const assessments = useMemo(
    () => latestAssessments(assessmentRows, today),
    [assessmentRows, today],
  );

  return (
    <Screen testID="risks-screen">
      <Stack.Screen options={{ title: t("mobile.risks.title") }} />
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
        <CarePersonHeader personId={id} />
        {risks.length === 0 ? (
          <Text tone="secondary" testID="risks-none">
            {t("mobile.risks.none")}
          </Text>
        ) : (
          risks.map((risk) => (
            <Card key={risk.id} title={risk.hazard} testID={`risk-${risk.id}`}>
              <View accessible style={{ gap: theme.space[0.5] }}>
                {risk.whoAtRisk ? <Text>{risk.whoAtRisk}</Text> : null}
                <Text emphasis>{risk.rating}</Text>
                {risk.residual ? <Text>{risk.residual}</Text> : null}
                {risk.review ? (
                  <Text
                    tone={risk.review.overdue ? "danger" : "secondary"}
                    emphasis={risk.review.overdue}
                  >
                    {risk.review.text}
                  </Text>
                ) : null}
              </View>
              {risk.controls.length > 0 ? (
                <View accessible style={{ gap: theme.space[0.5] }}>
                  <Text variant="bodyDense" tone="secondary" emphasis>
                    {t("mobile.risks.controls")}
                  </Text>
                  {risk.controls.map((control) => (
                    <Text key={control}>{control}</Text>
                  ))}
                </View>
              ) : null}
              {risk.positive ? (
                <View accessible style={{ gap: theme.space[0.5] }}>
                  <Text variant="bodyDense" tone="secondary" emphasis>
                    {t("mobile.risks.positive")}
                  </Text>
                  <Text>{risk.positive}</Text>
                </View>
              ) : null}
              {risk.personViews ? (
                <View accessible style={{ gap: theme.space[0.5] }}>
                  <Text variant="bodyDense" tone="secondary" emphasis>
                    {t("mobile.risks.personViews")}
                  </Text>
                  <Text>{risk.personViews}</Text>
                </View>
              ) : null}
            </Card>
          ))
        )}
        <Card title={t("mobile.risks.assessments")} testID="assessments">
          {assessments.length === 0 ? (
            <Text tone="secondary">{t("mobile.risks.noAssessments")}</Text>
          ) : (
            assessments.map((a) => (
              <View key={a.id} accessible style={{ gap: theme.space[0.5] }}>
                <Text emphasis>{a.tool}</Text>
                <Text>{a.result}</Text>
                {a.nextDue ? (
                  <Text
                    tone={a.nextDue.overdue ? "danger" : "secondary"}
                    emphasis={a.nextDue.overdue}
                  >
                    {a.nextDue.text}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}
