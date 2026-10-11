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
import { authClient, platformFetch } from "../auth/clients";
import { appEnv } from "../config/app-env";
import {
  DEVICE_ID_ITEM,
  deletePlain,
  HELD_WORK_ITEM,
  ME_ITEM,
  MODE_ITEM,
  readPlain,
  readPlainStrict,
  SESSION_TOKEN_ITEM,
  tombstoneStore,
  writePlain,
} from "../platform/secure-store";
import { DB_ID_ITEM } from "../security/db-key";
import { flushPendingReport } from "../sync/device-report";
import { admitSignIn, type HeldWork, loadHeldMarker, serialiseHeldWork } from "./held-work";
import { type AppMode, parseAppMode } from "./preferences-model";

export type SessionPhase = "loading" | "signedOut" | "signedIn";

interface SessionValue {
  readonly phase: SessionPhase;
  readonly token: string | null;
  readonly me: Me | null;
  readonly mode: AppMode | null;
  /** A message for the sign-in screen, for example after a remote sign-out. */
  readonly notice: string | null;
  /**
   * Entries kept on the device after the session ended (HZ-006): only their owner can sign in
   * and send them, or they can be deleted with "Sign out and delete N unsent entries".
   */
  readonly held: HeldWork | null;
  /** Stores a new session after sign-in and loads the user's details. */
  completeSignIn(token: string): Promise<void>;
  /** Refreshes `/v1/me` when online; an ended session is reported to the caller. */
  refreshMe(): Promise<"ok" | "offline" | "ended">;
  setMode(mode: AppMode): void;
  /** Forgets the session. Callers wipe the device first (see the vault). */
  clearSession(notice?: string): Promise<void>;
  /** Ends the session but keeps the device's unsent entries for their owner. */
  holdSession(held: HeldWork, notice?: string): Promise<void>;
  /**
   * Forgets the held entries marker: once the vault has put the owner's entries back into the
   * upload queue, or after a deliberate, recorded delete.
   */
  clearHeld(): Promise<void>;
  dismissNotice(): void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * The held marker, read failing closed: a keystore error means "held, owner unknown" (S3). A
 * marker without a deadline gets one and is saved (L2); after a keystore error nothing is written.
 */
async function readHeld(): Promise<HeldWork | null> {
  const { held, save } = await loadHeldMarker(
    {
      readMarker: () => readPlainStrict(HELD_WORK_ITEM),
      readDatabaseId: () => readPlainStrict(DB_ID_ITEM),
    },
    new Date(),
  );
  if (held && save)
    await writePlain(HELD_WORK_ITEM, serialiseHeldWork(held)).catch(() => undefined);
  return held;
}

/**
 * A device report waiting since a hold started (counts only) goes with the first session in the
 * same tenant, even one refused because the entries are someone else's. Best effort.
 */
async function sendWaitingReport(me: Me, token: string): Promise<void> {
  if (appEnv.demoMode) return;
  await flushPendingReport(tombstoneStore, {
    apiUrl: appEnv.apiUrl,
    fetch: platformFetch,
    token,
    tenantId: me.tenant.id,
    deviceId: await readPlain(DEVICE_ID_ITEM),
  }).catch(() => undefined);
}

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
  const [held, setHeld] = useState<HeldWork | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [storedToken, storedMe, storedMode, storedHeld] = await Promise.all([
        readPlain(SESSION_TOKEN_ITEM),
        readPlain(ME_ITEM),
        readPlain(MODE_ITEM),
        readHeld(),
      ]);
      if (!active) return;
      setHeld(storedHeld);
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
    // Entries held for someone else stay held: this sign-in is ended and refused (HZ-006).
    const current = await readHeld();
    setHeld(current);
    if (current) await sendWaitingReport(loaded, newToken);
    // The owner is back: the vault reopens the same encrypted database and puts the entries back
    // into the upload queue. The marker stays until that has worked (clinical review M2).
    await admitSignIn({
      held: current,
      me: loaded,
      token: newToken,
      signOut: (token) => authClient.signOut(token),
    });
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

  const holdSession = useCallback(async (next: HeldWork, message?: string) => {
    await writePlain(HELD_WORK_ITEM, serialiseHeldWork(next));
    // The mode is kept so the owner goes straight back to Care mode after signing in again.
    await Promise.all([deletePlain(SESSION_TOKEN_ITEM), deletePlain(ME_ITEM)]);
    setHeld(next);
    setToken(null);
    setMe(null);
    setNotice(message ?? null);
    setPhase("signedOut");
  }, []);

  const clearHeld = useCallback(async () => {
    await deletePlain(HELD_WORK_ITEM);
    setHeld(null);
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<SessionValue>(
    () => ({
      phase,
      token,
      me,
      mode,
      notice,
      held,
      completeSignIn,
      refreshMe,
      setMode,
      clearSession,
      holdSession,
      clearHeld,
      dismissNotice,
    }),
    [
      phase,
      token,
      me,
      mode,
      notice,
      held,
      completeSignIn,
      refreshMe,
      setMode,
      clearSession,
      holdSession,
      clearHeld,
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
