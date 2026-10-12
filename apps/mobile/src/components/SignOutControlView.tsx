import { Button, Text, useTheme } from "@harbour/ui-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import type { DiscardReason } from "../app-state/held-work";
import { t } from "../i18n/t";
import { DeleteWithReason } from "./DeleteWithReason";

/** What sign-out needs from the vault. */
export interface SignOutActions {
  countUnsent(): Promise<number | null>;
  signOutAndWipe(): Promise<void>;
  signOutDiscarding(choice: DiscardReason, count: number | null): Promise<void>;
}

/**
 * Sign-out from Settings and the lock screen (clinical review C2). It counts what has not reached
 * the server (queued, refused and held entries). With nothing unsent it asks for a plain
 * confirmation. Otherwise it shows the count (or that the count cannot be known while the database
 * is closed), and needs a coded reason, a confirmation naming the count and device authentication
 * before anything is deleted, which is put on record first (S4, M1, M2). Rendered in tests
 * (`sign-out.render.test.ts`).
 */
export function SignOutControlView({
  actions,
  variant,
  testID,
}: {
  readonly actions: SignOutActions;
  readonly variant: "destructive" | "secondary";
  readonly testID: string;
}) {
  const theme = useTheme();
  // undefined: not signing out; null: unsent entries cannot be counted; a number: the count.
  const [unsent, setUnsent] = useState<number | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);

  const start = async () => {
    setChecking(true);
    const count = await actions.countUnsent().catch(() => null);
    setChecking(false);
    if (count === 0) {
      Alert.alert(t("mobile.signOut.title"), t("mobile.signOut.body"), [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("mobile.signOut.button"),
          style: "destructive",
          onPress: () => {
            void actions.signOutAndWipe();
          },
        },
      ]);
      return;
    }
    setUnsent(count);
  };

  if (unsent === undefined) {
    return (
      <Button
        label={t("mobile.signOut.button")}
        variant={variant}
        onPress={() => {
          void start();
        }}
        loading={checking}
        accessibilityHint={t("mobile.signOut.body")}
        fullWidth
        testID={testID}
      />
    );
  }

  return (
    <View style={{ gap: theme.space[1] }} testID={`${testID}-unsent`}>
      <Text tone="danger" emphasis accessibilityRole="alert" testID={`${testID}-count`}>
        {unsent === null
          ? t("mobile.signOut.unsentUnknown")
          : t("mobile.signOut.unsent", { count: unsent })}
      </Text>
      <DeleteWithReason
        initiallyOpen
        buttonLabel={
          unsent === null
            ? t("mobile.signOut.discardUnknown")
            : t("mobile.held.discard", { count: unsent })
        }
        confirmTitle={
          unsent === null
            ? t("mobile.held.discardTitleUnknown")
            : t("mobile.held.discardTitle", { count: unsent })
        }
        confirmBody={t("mobile.held.discardBody")}
        reasonLabel={t("mobile.discard.reasonLabel")}
        onConfirm={(choice) => actions.signOutDiscarding(choice, unsent)}
        onCancel={() => setUnsent(undefined)}
        testID={`${testID}-discard`}
      />
    </View>
  );
}
