import { Button, Text, useTheme } from "@harbour/ui-native";
import { isSQLCipher } from "@op-engineering/op-sqlite";
import * as Application from "expo-application";
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, View } from "react-native";
import { usePreferences } from "../../app-state/preferences";
import { useSession } from "../../app-state/session";
import { useVault } from "../../app-state/vault";
import { platformFetch } from "../../auth/clients";
import { Screen } from "../../components/Screen";
import { SignOutControl } from "../../components/SignOutControl";
import { appEnv } from "../../config/app-env";
import { t } from "../../i18n/t";
import { deletionMessage, requestAccountDeletion } from "../../platform/account-deletion";
import { describeTimeout, SHARED_AUTO_LOCK_CHOICES_MS } from "../../security/auto-lock";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[1] }}>
      <Text variant="bodyDense" tone="secondary" emphasis accessibilityRole="header">
        {title}
      </Text>
      <View
        style={{
          backgroundColor: theme.colors.card,
          borderRadius: theme.radius.card,
          borderColor: theme.colors.border,
          borderWidth: 1,
          padding: theme.space[2],
          gap: theme.space[1.5],
        }}
      >
        {children}
      </View>
    </View>
  );
}

/** A choice row: radio semantics, 44 pt target, selected state spoken and shown with a word. */
function Choice({
  label,
  selected,
  onSelect,
  testID,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={label}
      onPress={onSelect}
      style={{
        minHeight: theme.touchTarget,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        borderRadius: theme.radius.input,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        paddingHorizontal: theme.space[1.5],
      }}
    >
      <Text emphasis={selected}>{label}</Text>
      {selected ? (
        <Text tone="accent" emphasis>
          Selected
        </Text>
      ) : null}
    </Pressable>
  );
}

function encryptionLabel(): string {
  try {
    return isSQLCipher()
      ? "Encrypted (SQLCipher, AES-256)"
      : "Not encrypted: care data is not stored";
  } catch {
    return "Unknown";
  }
}

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const session = useSession();
  const vault = useVault();
  const { preferences, update } = usePreferences();
  const [resyncing, setResyncing] = useState(false);
  const [asking, setAsking] = useState(false);
  const organisation = session.me?.tenant.name ?? "";

  // MOB-011: the stores' in-app deletion path. The account belongs to the care provider, so this
  // asks them; nothing is deleted on the device or the server by asking.
  const confirmDeletionRequest = () => {
    Alert.alert(
      t("mobile.account.confirmTitle"),
      t("mobile.account.confirmBody", { organisation }),
      [
        { text: t("mobile.account.cancel"), style: "cancel" },
        {
          text: t("mobile.account.confirmSend"),
          onPress: async () => {
            const me = session.me;
            if (!me || !session.token) {
              const message = deletionMessage({ kind: "session" }, organisation, t);
              Alert.alert(message.title, message.body);
              return;
            }
            setAsking(true);
            const outcome = await requestAccountDeletion({
              apiUrl: appEnv.apiUrl,
              fetch: platformFetch,
              token: session.token,
              tenantId: me.tenant.id,
              demoMode: appEnv.demoMode,
            });
            setAsking(false);
            const message = deletionMessage(outcome, organisation, t);
            Alert.alert(message.title, message.body);
          },
        },
      ],
    );
  };

  const confirmResync = () => {
    Alert.alert(
      "Download everything again?",
      "This clears the care data on this device and downloads it again. Use it when support asks you to. You need an internet connection.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Download again",
          onPress: async () => {
            setResyncing(true);
            const result = await vault.forceResync().catch(() => ({
              ok: false as const,
              reason: "The download could not start. Try again.",
            }));
            setResyncing(false);
            if (!result.ok) Alert.alert("Not downloaded", result.reason);
          },
        },
      ],
    );
  };

  const version = Application.nativeApplicationVersion ?? "development";
  const build = Application.nativeBuildVersion ?? "-";

  return (
    <Screen testID="settings-screen">
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[3] }}>
        <Section title="Account">
          <Text emphasis>{session.me?.user.name ?? "Signed in"}</Text>
          <Text tone="secondary">{session.me?.tenant.name}</Text>
          <Button
            label="Change mode"
            variant="secondary"
            onPress={() => router.push("/mode")}
            testID="settings-change-mode"
          />
          <SignOutControl variant="destructive" testID="settings-sign-out" />
        </Section>

        <Section title={t("mobile.account.deleteTitle")}>
          <Text tone="secondary">{t("mobile.account.deleteExplain", { organisation })}</Text>
          <Button
            label={t("mobile.account.deleteButton")}
            variant="secondary"
            loading={asking}
            onPress={confirmDeletionRequest}
            testID="settings-delete-account"
          />
        </Section>

        <Section title="Sync">
          <Text tone="secondary">
            If records look wrong or incomplete, download everything again.
          </Text>
          <Button
            label="Download all data again"
            variant="secondary"
            loading={resyncing}
            onPress={confirmResync}
            testID="settings-force-resync"
          />
        </Section>

        <Section title="Security">
          <Text tone="secondary">
            Harbour locks after {describeTimeout(vault.autoLockMs)} without use.
          </Text>
          <Text emphasis>This device is</Text>
          <Choice
            label="My own device"
            selected={preferences.deviceMode === "personal"}
            onSelect={() => update({ deviceMode: "personal" })}
            testID="device-mode-personal"
          />
          <Choice
            label="Shared with colleagues"
            selected={preferences.deviceMode === "shared"}
            onSelect={() => update({ deviceMode: "shared" })}
            testID="device-mode-shared"
          />
          {preferences.deviceMode === "shared" ? (
            <>
              <Text emphasis>Lock a shared device after</Text>
              {SHARED_AUTO_LOCK_CHOICES_MS.map((ms) => (
                <Choice
                  key={ms}
                  label={describeTimeout(ms)}
                  selected={preferences.sharedAutoLockMs === ms}
                  onSelect={() => update({ sharedAutoLockMs: ms })}
                  testID={`auto-lock-${ms}`}
                />
              ))}
            </>
          ) : null}
          <Button label="Lock now" variant="secondary" onPress={vault.lock} testID="lock-now" />
        </Section>

        <Section title="Display">
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: theme.touchTarget,
            }}
          >
            <Text style={{ flex: 1 }}>High contrast</Text>
            <Switch
              testID="high-contrast-switch"
              accessibilityLabel="High contrast"
              value={preferences.theme.highContrast}
              onValueChange={(highContrast) =>
                update({ theme: { ...preferences.theme, highContrast } })
              }
            />
          </View>
          <Text emphasis>Appearance</Text>
          {(["system", "light", "dark"] as const).map((scheme) => (
            <Choice
              key={scheme}
              label={scheme === "system" ? "Same as device" : scheme === "light" ? "Light" : "Dark"}
              selected={preferences.theme.scheme === scheme}
              onSelect={() => update({ theme: { ...preferences.theme, scheme } })}
              testID={`appearance-${scheme}`}
            />
          ))}
        </Section>

        <Section title="About">
          <Text testID="about-version">
            Harbour {version} (build {build})
          </Text>
          <Text tone="secondary">Local database: {encryptionLabel()}</Text>
          <Text tone="secondary">
            Device check: {vault.integrity?.reasons[0] ?? "Not checked yet"}
          </Text>
          {appEnv.demoMode ? <Text tone="secondary">Demo mode: invented data only.</Text> : null}
          <Text tone="secondary">Thapsus Cargo Ltd. Harbour is not a medical device.</Text>
        </Section>
      </ScrollView>
    </Screen>
  );
}
