import { Text, useTheme } from "@harbour/ui-native";
import { View } from "react-native";
import { useVault } from "../app-state/vault";
import { issueItem } from "../care/entry-view";
import { useUploadIssues } from "../care/hooks";
import { t } from "../i18n/t";
import { Card } from "./Card";
import { DeleteWithReason } from "./DeleteWithReason";

/**
 * Entries the server refused for good (HZ-006): never dropped silently. Each shows the person, the
 * server's reason and what was recorded, and leaves the device only when someone removes it after
 * recording it again or telling the nurse in charge: with a coded reason and device
 * authentication, and the removal sent to Harbour as an audit event before anything is removed
 * (security reviews S4, M1 and M2, clinical review C1). What was recorded stays on the device,
 * encrypted, until then; it never ages out on its own (clinical review M1).
 */
export function UploadIssues({ personId }: { readonly personId?: string }) {
  const theme = useTheme();
  const vault = useVault();
  const rows = useUploadIssues();
  const items = rows.map(issueItem).filter((i) => !personId || i.personId === personId);
  if (items.length === 0) return null;

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
          <DeleteWithReason
            buttonLabel={t("mobile.issues.remove")}
            confirmTitle={t("mobile.issues.removeTitle")}
            confirmBody={t("mobile.issues.removeBody")}
            confirmLabel={t("mobile.issues.remove")}
            reasonLabel={t("mobile.issues.removeReason")}
            onConfirm={(choice) => vault.removeRefused(item.id, choice)}
            withWords
            testID={`issue-${item.id}-remove`}
          />
        </View>
      ))}
    </Card>
  );
}
