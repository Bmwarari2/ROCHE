import { Button, Text, useTheme } from "@harbour/ui-native";
import { isSQLCipher } from "@op-engineering/op-sqlite";
import * as Application from "expo-application";
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, View } from "react-native";
import { usePreferences } from "../../app-state/preferences";
import { mayChangeDeviceMode, mayChangeLockTime } from "../../app-state/preferences-model";
import { useSession } from "../../app-state/session";
import { useVault } from "../../app-state/vault";
import { platformFetch } from "../../auth/clients";
import { Screen } from "../../components/Screen";
import { SignOutControl } from "../../components/SignOutControl";
import { appEnv } from "../../config/app-env";
import { t } from "../../i18n/t";
import {
  deletionMessage,
  organisationWords,
  requestAccountDeletion,
} from "../../platform/account-deletion";
import { describeTimeout, SHARED_AUTO_LOCK_CHOICES_MS } from "../../security/auto-lock";
import { TRAINING_SELF } from "../../training/hooks";

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
          {t("mobile.settings.selected")}
        </Text>
      ) : null}
    </Pressable>
  );
}

function encryptionLabel(): string {
  try {
    return t("mobile.settings.encryption", { state: isSQLCipher() ? "encrypted" : "none" });
  } catch {
    return t("mobile.settings.encryption", { state: "unknown" });
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
  const organisation = session.me?.tenant.name ?? null;

  // MOB-011: the stores' in-app deletion path. The account belongs to the care provider, so this
  // asks them; nothing is deleted on the device or the server by asking.
  const confirmDeletionRequest = () => {
    Alert.alert(
      t("mobile.account.confirmTitle"),
      t("mobile.account.confirmBody", organisationWords(organisation)),
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
    Alert.alert(t("mobile.settings.resyncTitle"), t("mobile.settings.resyncBody"), [
      { text: t("mobile.settings.cancel"), style: "cancel" },
      {
        text: t("mobile.settings.resyncConfirm"),
        onPress: async () => {
          setResyncing(true);
          const result = await vault.forceResync().catch(() => ({
            ok: false as const,
            reason: t("mobile.settings.resyncNotStarted"),
          }));
          setResyncing(false);
          if (!result.ok) Alert.alert(t("mobile.settings.resyncFailedTitle"), result.reason);
        },
      },
    ]);
  };

  const version = Application.nativeApplicationVersion;
  const build = Application.nativeBuildVersion;

  return (
    <Screen testID="settings-screen">
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[3] }}>
        <Section title={t("mobile.settings.section", { section: "account" })}>
          <Text emphasis>{session.me?.user.name ?? t("mobile.settings.signedIn")}</Text>
          <Text tone="secondary">{session.me?.tenant.name}</Text>
          <Button
            label={t("mobile.settings.changeMode")}
            variant="secondary"
            onPress={() => router.push("/mode")}
            testID="settings-change-mode"
          />
          <SignOutControl variant="destructive" testID="settings-sign-out" />
        </Section>

        {(session.me?.permissions ?? []).includes(TRAINING_SELF) ? (
          <Section title={t("mobile.training.title")}>
            <Button
              label={t("mobile.training.open")}
              variant="secondary"
              onPress={() => router.push("/training")}
              testID="settings-training"
            />
          </Section>
        ) : null}

        <Section title={t("mobile.account.deleteTitle")}>
          <Text tone="secondary">
            {t("mobile.account.deleteExplain", organisationWords(organisation))}
          </Text>
          <Button
            label={t("mobile.account.deleteButton")}
            variant="secondary"
            loading={asking}
            onPress={confirmDeletionRequest}
            testID="settings-delete-account"
          />
        </Section>

        <Section title={t("mobile.settings.section", { section: "sync" })}>
          <Text tone="secondary">{t("mobile.settings.resyncAbout")}</Text>
          <Button
            label={t("mobile.settings.resync")}
            variant="secondary"
            loading={resyncing}
            onPress={confirmResync}
            testID="settings-force-resync"
          />
        </Section>

        <Section title={t("mobile.settings.section", { section: "security" })}>
          <Text tone="secondary">
            {t("mobile.settings.locksAfter", { duration: describeTimeout(vault.autoLockMs, t) })}
          </Text>
          {/* Personal or shared, and how soon a shared device locks, are set by a manager who may
              withdraw devices, never by any signed-in member (guides review; HZ-001, H-1530). */}
          {/* Any member may make the phone safer (shared, or a shorter lock); only a manager who
              may withdraw devices makes it less safe (security review M2; HZ-001, H-1530). The
              choices are a labelled group (accessibility review). */}
          <Text emphasis accessibilityRole="header">
            {t("mobile.settings.deviceIs")}
          </Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={t("mobile.settings.deviceIs")}>
            {preferences.deviceMode === "personal" ||
            mayChangeDeviceMode(session.me?.permissions) ? (
              <Choice
                label={t("mobile.settings.deviceMode", { mode: "personal" })}
                selected={preferences.deviceMode === "personal"}
                onSelect={() => update({ deviceMode: "personal" })}
                testID="device-mode-personal"
              />
            ) : null}
            <Choice
              label={t("mobile.settings.deviceMode", { mode: "shared" })}
              selected={preferences.deviceMode === "shared"}
              onSelect={() => update({ deviceMode: "shared" })}
              testID="device-mode-shared"
            />
          </View>
          {preferences.deviceMode !== "personal" &&
          !mayChangeDeviceMode(session.me?.permissions) ? (
            <Text tone="secondary" testID="device-mode-fixed">
              {t("mobile.settings.deviceModeFixed", { mode: "shared" })}
            </Text>
          ) : null}
          {preferences.deviceMode === "shared" ? (
            <>
              <Text emphasis accessibilityRole="header">
                {t("mobile.settings.sharedLockAfter")}
              </Text>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={t("mobile.settings.sharedLockAfter")}
              >
                {SHARED_AUTO_LOCK_CHOICES_MS.filter((ms) =>
                  mayChangeLockTime(session.me?.permissions, preferences.sharedAutoLockMs, ms),
                ).map((ms) => (
                  <Choice
                    key={ms}
                    label={describeTimeout(ms, t)}
                    selected={preferences.sharedAutoLockMs === ms}
                    onSelect={() => update({ sharedAutoLockMs: ms })}
                    testID={`auto-lock-${ms}`}
                  />
                ))}
              </View>
            </>
          ) : null}
          <Button
            label={t("mobile.settings.lockNow")}
            variant="secondary"
            onPress={vault.lock}
            testID="lock-now"
          />
        </Section>

        <Section title={t("mobile.settings.section", { section: "display" })}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: theme.touchTarget,
            }}
          >
            <Text style={{ flex: 1 }}>{t("mobile.settings.highContrast")}</Text>
            <Switch
              testID="high-contrast-switch"
              accessibilityLabel={t("mobile.settings.highContrast")}
              value={preferences.theme.highContrast}
              onValueChange={(highContrast) =>
                update({ theme: { ...preferences.theme, highContrast } })
              }
            />
          </View>
          <Text emphasis>{t("mobile.settings.appearance")}</Text>
          {(["system", "light", "dark"] as const).map((scheme) => (
            <Choice
              key={scheme}
              label={t("mobile.settings.scheme", { scheme })}
              selected={preferences.theme.scheme === scheme}
              onSelect={() => update({ theme: { ...preferences.theme, scheme } })}
              testID={`appearance-${scheme}`}
            />
          ))}
        </Section>

        <Section title={t("mobile.settings.section", { section: "about" })}>
          <Text testID="about-version">
            {version && build
              ? t("mobile.settings.version", { version, build })
              : t("mobile.settings.versionDevelopment")}
          </Text>
          <Text tone="secondary">
            {t("mobile.settings.localDatabase", { state: encryptionLabel() })}
          </Text>
          <Text tone="secondary">
            {vault.integrity?.reasons[0]
              ? t("mobile.settings.deviceCheck", { result: vault.integrity.reasons[0] })
              : t("mobile.settings.deviceNotChecked")}
          </Text>
          {appEnv.demoMode ? <Text tone="secondary">{t("mobile.settings.demo")}</Text> : null}
          <Text tone="secondary">{t("mobile.settings.notMedicalDevice")}</Text>
        </Section>
      </ScrollView>
    </Screen>
  );
}
