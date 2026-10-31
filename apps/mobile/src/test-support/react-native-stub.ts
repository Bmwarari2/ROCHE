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

export const AccessibilityInfo = {
  isDarkerSystemColorsEnabled: async () => false,
  isHighTextContrastEnabled: async () => false,
  isReduceMotionEnabled: async () => false,
  addEventListener: () => ({ remove: () => undefined }),
  announced: [] as string[],
  focused: [] as unknown[],
  announceForAccessibility(message: string) {
    AccessibilityInfo.announced.push(message);
  },
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
