import { Button, Text, useTheme } from "@harbour/ui-native";
import { usePowerSync } from "@powersync/react";
import { Alert, View } from "react-native";
import { issueItem } from "../care/entry-view";
import { useTenantId, useUploadIssues } from "../care/hooks";
import { DELETE_UPLOAD_ISSUE_SQL } from "../care/queries";
import { t } from "../i18n/t";
import { Card } from "./Card";

/**
 * Entries the server refused for good (HZ-006): never dropped silently. Each shows the person, the
 * server's reason and what was recorded, and leaves the device only when someone removes it after
 * recording it again or telling the nurse in charge.
 */
export function UploadIssues({ personId }: { readonly personId?: string }) {
  const theme = useTheme();
  const db = usePowerSync();
  const tenantId = useTenantId();
  const rows = useUploadIssues();
  const items = rows.map(issueItem).filter((i) => !personId || i.personId === personId);
  if (items.length === 0) return null;

  const remove = (id: string) =>
    Alert.alert(t("mobile.issues.removeTitle"), t("mobile.issues.removeBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("mobile.issues.remove"),
        style: "destructive",
        onPress: () => {
          void db.execute(DELETE_UPLOAD_ISSUE_SQL, [tenantId, id]);
        },
      },
    ]);

  return (
    <Card title={t("mobile.issues.title")} testID="upload-issues">
      <Text tone="danger" accessibilityRole="alert">
        {t("mobile.issues.body")}
      </Text>
      {items.map((item) => (
        <View key={item.id} style={{ gap: theme.space[0.5] }} testID={`issue-${item.id}`}>
          <View accessible style={{ gap: theme.space[0.5] }}>
            <Text emphasis>{item.title}</Text>
            {item.when ? (
              <Text variant="bodyDense" tone="secondary">
                {item.when}
              </Text>
            ) : null}
            <Text variant="bodyDense">{item.reason}</Text>
            {item.content ? <Text variant="bodyDense">{item.content}</Text> : null}
          </View>
          <Button
            label={t("mobile.issues.remove")}
            variant="secondary"
            onPress={() => remove(item.id)}
            testID={`issue-${item.id}-remove`}
          />
        </View>
      ))}
    </Card>
  );
}
