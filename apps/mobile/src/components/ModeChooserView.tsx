import { ListItem, ListSection, Text, useTheme } from "@harbour/ui-native";
import { ScrollView, View } from "react-native";
import type { AppMode } from "../app-state/preferences-model";
import { type MessageKey, t } from "../i18n/t";
import { DemoNotice } from "./DemoNotice";

const modes: ReadonlyArray<{ mode: AppMode; title: MessageKey; hint: MessageKey }> = [
  { mode: "care", title: "mobile.mode.care", hint: "mobile.mode.careHint" },
  { mode: "manage", title: "mobile.mode.manage", hint: "mobile.mode.manageHint" },
  { mode: "family", title: "mobile.mode.family", hint: "mobile.mode.familyHint" },
];

export interface ModeChooserViewProps {
  /** Demo builds say so here too, before any care screen is open. */
  readonly demo: boolean;
  onChoose(mode: AppMode): void;
}

/**
 * The mode chooser after sign-in (section 17), drawn from its props so it can be render-tested; the
 * route (`app/mode.tsx`) places it inside the safe area.
 */
export function ModeChooserView({ demo, onChoose }: ModeChooserViewProps) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1 }}>
      {demo ? <DemoNotice /> : null}
      <ScrollView contentContainerStyle={{ padding: theme.space[2], gap: theme.space[2] }}>
        <View style={{ gap: theme.space[1] }}>
          <Text variant="title" accessibilityRole="header">
            {t("mobile.mode.title")}
          </Text>
          <Text tone="secondary">{t("mobile.mode.hint")}</Text>
        </View>
        <ListSection>
          {modes.map((item) => (
            <ListItem
              key={item.mode}
              testID={`mode-${item.mode}`}
              title={t(item.title)}
              subtitle={t(item.hint)}
              onPress={() => onChoose(item.mode)}
            />
          ))}
        </ListSection>
      </ScrollView>
    </View>
  );
}
