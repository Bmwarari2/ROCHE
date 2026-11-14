/**
 * Test support: a stand-in for `react-native` so components can be rendered in Node with
 * `react-test-renderer` (the real package needs the native runtime). Host components render as
 * elements named after the component, keeping their props (testID, accessibility props and text),
 * which is what the render tests read. Only what the rendered components use is provided.
 */
export const View = "View";
export const Text = "Text";
export const Image = "Image";
export const Pressable = "Pressable";
export const ScrollView = "ScrollView";
export const KeyboardAvoidingView = "KeyboardAvoidingView";
export const ActivityIndicator = "ActivityIndicator";
export const TextInput = "TextInput";

/** Links are recorded rather than opened. */
export const Linking = {
  opened: [] as string[],
  async openURL(url: string) {
    Linking.opened.push(url);
  },
};

/** Alerts are recorded rather than shown, so a render test can read and answer them. */
export const Alert = {
  calls: [] as Array<{
    title: string;
    message?: string;
    buttons?: Array<{ text?: string; style?: string; onPress?: () => void }>;
  }>,
  alert(
    title: string,
    message?: string,
    buttons?: Array<{ text?: string; style?: string; onPress?: () => void }>,
  ) {
    Alert.calls.push({ title, message, buttons });
  },
};

export const StyleSheet = {
  create: <T>(styles: T): T => styles,
  flatten: <T>(style: T): T => style,
  absoluteFill: {},
  hairlineWidth: 1,
};

export const Platform = {
  OS: "ios" as const,
  select: <T>(options: { ios?: T; default?: T }): T | undefined => options.ios ?? options.default,
};

/** App state changes a test sends (`emit`), as the platform would on going to the background. */
export const AppState = {
  listeners: [] as Array<(next: string) => void>,
  addEventListener(_event: "change", handler: (next: string) => void) {
    AppState.listeners.push(handler);
    return {
      remove: () => {
        const at = AppState.listeners.indexOf(handler);
        if (at >= 0) AppState.listeners.splice(at, 1);
      },
    };
  },
  emit(next: string) {
    for (const handler of [...AppState.listeners]) handler(next);
  },
};

export const AccessibilityInfo = {
  /** What would be read out, so a render test can check a screen reader hears it. */
  announced: [] as string[],
  announceForAccessibility(text: string) {
    AccessibilityInfo.announced.push(text);
  },
  /** Announcements with their options, so a test can check one was queued. */
  announcedWith: [] as Array<{ text: string; options: { queue?: boolean } }>,
  announceForAccessibilityWithOptions(text: string, options: { queue?: boolean }) {
    AccessibilityInfo.announced.push(text);
    AccessibilityInfo.announcedWith.push({ text, options });
  },
  isDarkerSystemColorsEnabled: async () => false,
  isHighTextContrastEnabled: async () => false,
  isReduceMotionEnabled: async () => false,
  /** Listeners by event, so a test can send what the platform would (`emit`). */
  listeners: [] as Array<{ event: string; handler: (payload: never) => void }>,
  addEventListener(event: string, handler: (payload: never) => void) {
    const entry = { event, handler };
    AccessibilityInfo.listeners.push(entry);
    return {
      remove: () => {
        const at = AccessibilityInfo.listeners.indexOf(entry);
        if (at >= 0) AccessibilityInfo.listeners.splice(at, 1);
      },
    };
  },
  emit(event: string, payload: unknown) {
    for (const entry of [...AccessibilityInfo.listeners]) {
      if (entry.event === event) entry.handler(payload as never);
    }
  },
  focused: [] as unknown[],
  setAccessibilityFocus(node: unknown) {
    AccessibilityInfo.focused.push(node);
  },
};

/** The native view behind a host element: the test renderer's instance stands in for it. */
export function findNodeHandle(instance: unknown): unknown {
  return instance ?? null;
}

/** The window a render test draws into; a test sets it to draw a phone or a tablet. */
export const testWindow = { width: 393, height: 852, fontScale: 1, scale: 3 };

export function useWindowDimensions() {
  return testWindow;
}

export function useColorScheme(): "light" {
  return "light";
}
