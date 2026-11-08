/**
 * Local notifications for held entries (security review M3, clinical review H2): when a hold's
 * last day starts and when it escalates to a manager. The words carry no names, counts or care
 * details, because a notification shows on the lock screen. Nothing is sent to a push service;
 * the notifications are scheduled on the device only.
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { t } from "../i18n/t";
import { MEDS_REMINDER_PREFIX, type PlannedReminder } from "../medicines/reminders";
import { HELD_NOTIFICATION_IDS, type PlannedNotification } from "../sync/held-limit";

const CHANNEL_ID = "held-entries";

async function permitted(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** Cancels both held-entry notifications. Never throws. */
export async function cancelHeldNotifications(): Promise<void> {
  for (const identifier of Object.values(HELD_NOTIFICATION_IDS)) {
    await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => undefined);
  }
}

/**
 * Replaces the held-entry notifications with the plan. Best effort and never throws: the sign-in
 * screen shows the same warning and escalation whether or not notifications are allowed.
 */
export async function scheduleHeldNotifications(
  plan: readonly PlannedNotification[],
): Promise<void> {
  try {
    await cancelHeldNotifications();
    if (plan.length === 0 || !(await permitted())) return;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: t("mobile.held.notificationChannel"),
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    for (const item of plan) {
      await Notifications.scheduleNotificationAsync({
        identifier: item.identifier,
        content: {
          title: t("mobile.held.notificationTitle"),
          body:
            item.kind === "final"
              ? t("mobile.held.notificationFinal")
              : t("mobile.held.notificationEscalated"),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: item.at,
          ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
        },
      });
    }
  } catch {
    // The sign-in screen carries the same message.
  }
}

const MEDS_CHANNEL_ID = "time-critical-medicines";

/**
 * Replaces the time-critical dose reminders with the plan (slice 69). Best effort, never throws:
 * the round shows the same doses due whether or not reminders are allowed. The words name no one.
 */
export async function scheduleMedicineReminders(plan: readonly PlannedReminder[]): Promise<void> {
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const n of scheduled) {
      if (n.identifier.startsWith(MEDS_REMINDER_PREFIX)) {
        await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => undefined);
      }
    }
    if (plan.length === 0 || !(await permitted())) return;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(MEDS_CHANNEL_ID, {
        name: t("mobile.meds.reminderChannel"),
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    for (const item of plan) {
      await Notifications.scheduleNotificationAsync({
        identifier: item.identifier,
        content: { title: t("mobile.meds.reminderTitle"), body: t("mobile.meds.reminderBody") },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: item.at,
          ...(Platform.OS === "android" ? { channelId: MEDS_CHANNEL_ID } : {}),
        },
      });
    }
  } catch {
    // The round carries the same doses.
  }
}
