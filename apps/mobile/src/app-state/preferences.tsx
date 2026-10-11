import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { PREFERENCES_ITEM, readPlain, writePlain } from "../platform/secure-store";
import { defaultPreferences, type Preferences, parsePreferences } from "./preferences-model";

interface PreferencesValue {
  readonly preferences: Preferences;
  readonly loaded: boolean;
  update(patch: Partial<Preferences>): void;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

export function PreferencesProvider({ children }: { readonly children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    readPlain(PREFERENCES_ITEM).then((raw) => {
      if (!active) return;
      setPreferences(parsePreferences(raw));
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    writePlain(PREFERENCES_ITEM, JSON.stringify(preferences)).catch(() => undefined);
  }, [preferences, loaded]);

  const update = useCallback((patch: Partial<Preferences>) => {
    setPreferences((previous) => ({ ...previous, ...patch }));
  }, []);

  const value = useMemo(() => ({ preferences, loaded, update }), [preferences, loaded, update]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}
