import { ukIsoDate } from "@harbour/domain";
import { Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { useTenantId } from "../../../../care/hooks";
import {
  CARE_PLAN_SQL,
  type CarePlanRow,
  PLAN_ACTIONS_SQL,
  PLAN_SECTIONS_SQL,
  type PlanActionRow,
  type PlanSectionRow,
} from "../../../../care/queries";
import { carePlanView } from "../../../../care/records";
import { Card } from "../../../../components/Card";
import { CarePersonHeader } from "../../../../components/CarePersonHeader";
import { Screen } from "../../../../components/Screen";
import { t } from "../../../../i18n/t";
import { useRecordScreenProtection } from "../../../../security/use-record-protection";

function Labelled({ label, value }: { readonly label: string; readonly value: string | null }) {
  const theme = useTheme();
  if (!value) return null;
  return (
    <View accessible style={{ gap: theme.space[0.5] }}>
      <Text variant="bodyDense" tone="secondary" emphasis>
        {label}
      </Text>
      <Text>{value}</Text>
    </View>
  );
}

/** The active care plan, read only on the phone (care.md section 6). Drafts never reach a device. */
export default function CarePlanScreen() {
  useRecordScreenProtection("care-plan");
  const theme = useTheme();
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const id = typeof personId === "string" ? personId : "";
  const tenantId = useTenantId();

  const params = useMemo(() => [tenantId, id], [tenantId, id]);
  const { data: plans } = useQuery<CarePlanRow>(CARE_PLAN_SQL, params);
  const plan = plans[0] ?? null;
  const planParams = useMemo(() => [tenantId, plan?.id ?? ""], [tenantId, plan?.id]);
  const { data: sections } = useQuery<PlanSectionRow>(PLAN_SECTIONS_SQL, planParams);
  const { data: actions } = useQuery<PlanActionRow>(PLAN_ACTIONS_SQL, planParams);
  const view = plan ? carePlanView(plan, sections, actions, ukIsoDate(new Date())) : null;

  return (
    <Screen testID="care-plan-screen">
      <Stack.Screen options={{ title: t("mobile.carePlan.title") }} />
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
        <CarePersonHeader personId={id} />
        {view ? (
          <>
            <Card>
              {view.version ? <Text emphasis>{view.version}</Text> : null}
              {view.review ? (
                <Text
                  tone={view.review.overdue ? "danger" : "secondary"}
                  emphasis={view.review.overdue}
                  testID="care-plan-review"
                >
                  {view.review.text}
                </Text>
              ) : null}
              {view.summary ? <Text>{view.summary}</Text> : null}
              <Text variant="bodyDense" tone="secondary">
                {t("mobile.carePlan.readOnly")}
              </Text>
            </Card>
            {view.sections.map((section) => (
              <Card
                key={section.id}
                title={section.title}
                testID={`care-plan-section-${section.id}`}
              >
                <Labelled label={t("mobile.carePlan.need")} value={section.need} />
                <Labelled label={t("mobile.carePlan.outcome")} value={section.outcome} />
                <Labelled label={t("mobile.carePlan.strengths")} value={section.strengths} />
                <Labelled label={t("mobile.carePlan.contingency")} value={section.contingency} />
                {section.actions.length > 0 ? (
                  <View style={{ gap: theme.space[1] }}>
                    <Text variant="bodyDense" tone="secondary" emphasis>
                      {t("mobile.carePlan.actions")}
                    </Text>
                    {section.actions.map((action) => (
                      <View key={action.id} accessible style={{ gap: theme.space[0.5] }}>
                        <Text emphasis>{action.action}</Text>
                        <Text variant="bodyDense">{action.when}</Text>
                        {action.who ? <Text variant="bodyDense">{action.who}</Text> : null}
                      </View>
                    ))}
                  </View>
                ) : null}
              </Card>
            ))}
          </>
        ) : (
          <Text tone="secondary" testID="care-plan-none">
            {t("mobile.carePlan.none")}
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}
