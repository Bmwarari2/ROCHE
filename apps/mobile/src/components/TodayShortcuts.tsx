import { Button, Text, useTheme } from "@harbour/ui-native";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { t } from "../i18n/t";
import { Card } from "./Card";
import { LoneWorkingPanel } from "./LoneWorkingPanel";

export type TodayLoneWorkingProps = ComponentProps<typeof LoneWorkingPanel>;

/**
 * Lone working on Today (HZ-125; redesign clinical review H2). While a session is open, the whole
 * panel sits at the top of Today, so Check in, the duress long press and Ask for help are one tap
 * from the first screen, never behind More. With no session open, starting one stays under More,
 * Shifts.
 */
export function TodayLoneWorking(props: TodayLoneWorkingProps) {
  if (props.view.kind !== "session") return null;
  return <LoneWorkingPanel {...props} />;
}

/**
 * The handover, one tap from Today for those who take part in it (redesign clinical review M3), so
 * moving it under More never hides it at the start of a shift.
 */
export function HandoverShortcut({ onOpen }: { readonly onOpen: () => void }) {
  const theme = useTheme();
  return (
    <Card title={t("mobile.handover.title")} testID="today-handover">
      <View style={{ gap: theme.space[1] }}>
        <Text tone="secondary">{t("mobile.today.handoverHint")}</Text>
        <Button
          label={t("mobile.today.handoverOpen")}
          variant="secondary"
          onPress={onOpen}
          testID="today-handover-open"
        />
      </View>
    </Card>
  );
}
