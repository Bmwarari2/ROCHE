import { useTheme, withAlpha } from "@harbour/ui-native";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useState } from "react";
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
  // The tab set is fixed when Care mode opens: changing it would rebuild the navigator and lose the
  // member's place and screen reader focus (review L1). A permission given later shows next time;
  // one taken away is still refused by the screen itself.
  const [destinations] = useState(() => careDestinations(me?.permissions ?? []));
  const android = theme.platform === "android";
  // iOS: only the brand tint, so the system keeps Liquid Glass's own contrast over any content,
  // Increase Contrast and Reduce Transparency included (review M3). Android: the Material 3 bar,
  // its selected item marked by the indicator, the text-coloured icon and a bold label (review M2).
  const androidColours = android
    ? {
        iconColor: { default: theme.colors.textSecondary, selected: theme.colors.text },
        labelStyle: {
          default: { color: theme.colors.textSecondary },
          selected: { color: theme.colors.text, fontWeight: "700" as const },
        },
        backgroundColor: theme.colors.nav,
        indicatorColor: theme.colors.accentContainer,
        rippleColor: withAlpha(theme.colors.text, 0.12),
        labelVisibilityMode: "labeled" as const,
      }
    : {};
  return (
    <NativeTabs
      tintColor={theme.colors.accent}
      minimizeBehavior="never"
      disableTransparentOnScrollEdge
      {...androidColours}
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
