import { Text, useTheme } from "@harbour/ui-native";
import { useQuery } from "@powersync/react";
import { useMemo } from "react";
import { View } from "react-native";
import { useTenantId } from "../care/hooks";
import {
  DEMO_QUEUED_INCIDENTS_SQL,
  QUEUED_INCIDENTS_SQL,
  queuedIncidentsFor,
} from "../care/incidents";
import { parseInstant, ukDateTimeParts } from "../care/time";
import { appEnv } from "../config/app-env";
import { t } from "../i18n/t";
import { Card } from "./Card";
import { StatusLine } from "./StatusLine";

/**
 * Incident reports about this person still on the phone (HZ-006): nobody has been told of them
 * yet, so the record says so in words until each is sent. A refused one moves to "needs
 * attention" with the API's reason.
 */
export function QueuedIncidents({ personId }: { readonly personId: string }) {
  const theme = useTheme();
  const tenantId = useTenantId();
  const { data } = useQuery<{ data: string | null }>(
    appEnv.demoMode ? DEMO_QUEUED_INCIDENTS_SQL : QUEUED_INCIDENTS_SQL,
  );
  const items = useMemo(
    () => queuedIncidentsFor(data, tenantId, personId),
    [data, tenantId, personId],
  );
  if (items.length === 0) return null;
  return (
    <Card title={t("mobile.incident.waitingTitle")} testID="incidents-waiting">
      <StatusLine tone="warning">
        {t(appEnv.demoMode ? "mobile.incident.waitingDemo" : "mobile.incident.waiting", {
          count: items.length,
        })}
      </StatusLine>
      {items.map((item) => (
        <View key={item.id} accessible style={{ gap: theme.space[0.5] }}>
          <Text emphasis>{t("mobile.incident.typeName", { type: item.type })}</Text>
          {happened(item.occurredAt) ? (
            <Text variant="bodyDense" tone="secondary">
              {t("mobile.incident.happened", happened(item.occurredAt) ?? {})}
            </Text>
          ) : null}
        </View>
      ))}
    </Card>
  );
}

function happened(value: string | null): { date: string; time: string } | null {
  const at = parseInstant(value);
  return at ? ukDateTimeParts(at) : null;
}
