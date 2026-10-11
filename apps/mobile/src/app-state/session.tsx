/**
 * Who is signed in. The session token and the cached `/v1/me` answer live in the keystore (this
 * device only) so the app can start offline; the care data itself lives in the encrypted database
 * managed by the vault.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AuthError, type Me, parseMe } from "../auth/auth-client";
import { authClient } from "../auth/clients";
import {
  deletePlain,
  ME_ITEM,
  MODE_ITEM,
  readPlain,
  SESSION_TOKEN_ITEM,
  writePlain,
} from "../platform/secure-store";
import { type AppMode, parseAppMode } from "./preferences-model";

export type SessionPhase = "loading" | "signedOut" | "signedIn";

interface SessionValue {
  readonly phase: SessionPhase;
  readonly token: string | null;
  readonly me: Me | null;
  readonly mode: AppMode | null;
  /** A message for the sign-in screen, for example after a remote sign-out. */
  readonly notice: string | null;
  /** Stores a new session after sign-in and loads the user's details. */
  completeSignIn(token: string): Promise<void>;
  /** Refreshes `/v1/me` when online; an ended session is reported to the caller. */
  refreshMe(): Promise<"ok" | "offline" | "ended">;
  setMode(mode: AppMode): void;
  /** Forgets the session. Callers wipe the device first (see the vault). */
  clearSession(notice?: string): Promise<void>;
  dismissNotice(): void;
}

const SessionContext = createContext<SessionValue | null>(null);

function parseStoredMe(raw: string | null): Me | null {
  if (!raw) return null;
  try {
    return parseMe(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const [phase, setPhase] = useState<SessionPhase>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [mode, setModeState] = useState<AppMode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [storedToken, storedMe, storedMode] = await Promise.all([
        readPlain(SESSION_TOKEN_ITEM),
        readPlain(ME_ITEM),
        readPlain(MODE_ITEM),
      ]);
      if (!active) return;
      const parsedMe = parseStoredMe(storedMe);
      // Without the cached tenant the app cannot scope offline queries, so it starts signed out.
      if (storedToken && parsedMe) {
        setToken(storedToken);
        setMe(parsedMe);
        setModeState(parseAppMode(storedMode));
        setPhase("signedIn");
      } else {
        setPhase("signedOut");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const completeSignIn = useCallback(async (newToken: string) => {
    const loaded = await authClient.getMe(newToken);
    await writePlain(SESSION_TOKEN_ITEM, newToken);
    await writePlain(ME_ITEM, JSON.stringify(loaded));
    setToken(newToken);
    setMe(loaded);
    setNotice(null);
    setPhase("signedIn");
  }, []);

  const refreshMe = useCallback(async () => {
    if (!token) return "ended" as const;
    try {
      const loaded = await authClient.getMe(token);
      await writePlain(ME_ITEM, JSON.stringify(loaded));
      setMe(loaded);
      return "ok" as const;
    } catch (error) {
      if (error instanceof AuthError && error.kind === "session_expired") return "ended" as const;
      return "offline" as const;
    }
  }, [token]);

  const setMode = useCallback((next: AppMode) => {
    setModeState(next);
    writePlain(MODE_ITEM, next).catch(() => undefined);
  }, []);

  const clearSession = useCallback(async (message?: string) => {
    await Promise.all([
      deletePlain(SESSION_TOKEN_ITEM),
      deletePlain(ME_ITEM),
      deletePlain(MODE_ITEM),
    ]);
    setToken(null);
    setMe(null);
    setModeState(null);
    setNotice(message ?? null);
    setPhase("signedOut");
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<SessionValue>(
    () => ({
      phase,
      token,
      me,
      mode,
      notice,
      completeSignIn,
      refreshMe,
      setMode,
      clearSession,
      dismissNotice,
    }),
    [
      phase,
      token,
      me,
      mode,
      notice,
      completeSignIn,
      refreshMe,
      setMode,
      clearSession,
      dismissNotice,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
