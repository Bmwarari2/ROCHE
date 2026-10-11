import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, useColorScheme } from "react-native";
import {
  buildTheme,
  defaultThemePreference,
  resolveScheme,
  type Theme,
  type ThemePreference,
} from "../logic/theme";

/**
 * Haptic feedback is injected (for example backed by expo-haptics) so this package has no native
 * dependency of its own and stays testable. Every method must be safe to call and must not throw.
 */
export interface HapticsAdapter {
  /** A light tick for ordinary presses. */
  selection(): void;
  /** Confirmation that something completed. */
  success(): void;
  /** Before or after a destructive action. */
  warning(): void;
}

interface ThemeContextValue {
  readonly theme: Theme;
  readonly preference: ThemePreference;
  readonly haptics: HapticsAdapter | null;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Tracks the operating system's own contrast setting: "Increase contrast" (iOS) and
 * "High contrast text" (Android). Each call resolves false on the other platform.
 */
function useSystemHighContrast(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([
      AccessibilityInfo.isDarkerSystemColorsEnabled().catch(() => false),
      AccessibilityInfo.isHighTextContrastEnabled().catch(() => false),
    ]).then(([ios, android]) => {
      if (active) setEnabled(ios || android);
    });
    const subscriptions = [
      AccessibilityInfo.addEventListener("darkerSystemColorsChanged", (value: boolean) =>
        setEnabled(value),
      ),
      AccessibilityInfo.addEventListener("highTextContrastChanged", (value: boolean) =>
        setEnabled(value),
      ),
    ];
    return () => {
      active = false;
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);
  return enabled;
}

export interface ThemeProviderProps {
  /** The user's choice; "system" follows the device light or dark setting. */
  readonly preference?: ThemePreference;
  readonly haptics?: HapticsAdapter | null;
  readonly children: ReactNode;
}

export function ThemeProvider({
  preference = defaultThemePreference,
  haptics = null,
  children,
}: ThemeProviderProps) {
  const systemScheme = useColorScheme();
  const systemHighContrast = useSystemHighContrast();
  const scheme = resolveScheme(preference.scheme, systemScheme);
  const highContrast = preference.highContrast || systemHighContrast;

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: buildTheme(scheme, highContrast), preference, haptics }),
    [scheme, highContrast, preference, haptics],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const fallback: ThemeContextValue = {
  theme: buildTheme("light", false),
  preference: defaultThemePreference,
  haptics: null,
};

/** The resolved theme. Outside a provider it falls back to the light theme. */
export function useTheme(): Theme {
  return (useContext(ThemeContext) ?? fallback).theme;
}

export function useThemePreference(): ThemePreference {
  return (useContext(ThemeContext) ?? fallback).preference;
}

export function useHaptics(): HapticsAdapter | null {
  return (useContext(ThemeContext) ?? fallback).haptics;
}
