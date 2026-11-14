import { useTheme } from "@harbour/ui-native";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { careDestinations } from "../../app-state/care-destinations";
import { useSession } from "../../app-state/session";
import { t } from "../../i18n/t";
import { useDmdSubsetRefresh } from "../../medicines/use-dmd-subset";

/**
 * Care mode's tab bar (ADR-0138): the platform's own, so iOS 26 draws it in Liquid Glass and
 * Android draws Material 3's navigation bar. Five tabs at most, as both platforms require: Today,
 * Round, Medicines (only for those the medicines streams reach), People and More, which holds
 * Handover, Shifts, Training and Settings (`app-state/care-destinations.ts`).
 *
 * Icons are Lucide, drawn as template images (`scripts/tab-icons.mjs`), never SF Symbols; the
 * platform tints them. The bar's labels are the platform's own size: iOS shows a large version of
 * an item on a long press (Large Content Viewer) and Android scales them with the font size
 * (ADR-0138 records this exception to the 15 pt minimum).
 */
export default function CareLayout() {
  const theme = useTheme();
  // The dm+d rows the MARs need, kept fresh while connected (slice 68).
  useDmdSubsetRefresh();
  const { me } = useSession();
  const destinations = careDestinations(me?.permissions ?? []);
  const android = theme.platform === "android";
  return (
    <NativeTabs
      tintColor={theme.colors.accent}
      iconColor={{
        default: theme.colors.textSecondary,
        selected: android ? theme.colors.onAccentContainer : theme.colors.accent,
      }}
      labelStyle={{
        default: { color: theme.colors.textSecondary },
        selected: { color: android ? theme.colors.text : theme.colors.accent },
      }}
      // Android only: the Material 3 bar on the container surface, with its active-indicator pill.
      // iOS sets no background, so the system draws the Liquid Glass bar.
      backgroundColor={android ? theme.colors.nav : undefined}
      indicatorColor={theme.colors.accentContainer}
      rippleColor={theme.colors.pressed}
      labelVisibilityMode="labeled"
      disableTransparentOnScrollEdge
    >
      <NativeTabs.Trigger
        name="today"
        testID="tab-today"
        accessibilityLabel={t("mobile.today.title")}
      >
        <NativeTabs.Trigger.Icon src={require("../../../assets/tabs/today.png")} />
        <NativeTabs.Trigger.Label>{t("mobile.today.title")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="round"
        testID="tab-round"
        accessibilityLabel={t("mobile.round.title")}
      >
        <NativeTabs.Trigger.Icon src={require("../../../assets/tabs/round.png")} />
        <NativeTabs.Trigger.Label>{t("mobile.round.title")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="medicines"
        testID="tab-medicines"
        accessibilityLabel={t("mobile.meds.title")}
        hidden={!destinations.medicines}
      >
        <NativeTabs.Trigger.Icon src={require("../../../assets/tabs/medicines.png")} />
        <NativeTabs.Trigger.Label>{t("mobile.meds.title")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="people"
        testID="tab-people"
        accessibilityLabel={t("mobile.tabs.people")}
      >
        <NativeTabs.Trigger.Icon src={require("../../../assets/tabs/people.png")} />
        <NativeTabs.Trigger.Label>{t("mobile.tabs.people")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more" testID="tab-more" accessibilityLabel={t("mobile.tabs.more")}>
        <NativeTabs.Trigger.Icon src={require("../../../assets/tabs/more.png")} />
        <NativeTabs.Trigger.Label>{t("mobile.tabs.more")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
