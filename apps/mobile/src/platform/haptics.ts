import type { HapticsAdapter } from "@harbour/ui-native";
import * as Haptics from "expo-haptics";

/** Haptics never throw into the UI: a device without a vibration motor just stays silent. */
function quietly(run: () => Promise<void>): void {
  run().catch(() => undefined);
}

export const expoHaptics: HapticsAdapter = {
  selection: () => quietly(() => Haptics.selectionAsync()),
  success: () => quietly(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => quietly(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};
