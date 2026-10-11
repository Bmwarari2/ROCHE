/**
 * The vault: the encrypted on-device database and the lock in front of it.
 *
 * - Unlocking from cold start reads the per-install key from the keystore, which shows the
 *   biometric prompt (or, where biometrics are unavailable, the device passcode prompt), then opens
 *   the SQLCipher database and starts PowerSync (or seeds demo data).
 * - Auto-lock after idle (2 minutes personal, 30 seconds to 2 minutes shared) covers the app with
 *   the lock screen; the database stays open so sync carries on, and unlocking again needs strong
 *   biometrics or the passcode.
 * - Sign-out wipes the device: the database is cleared, closed and deleted, and the key destroyed,
 *   so nothing readable remains. With entries that have not reached the server, sign-out shows how
 *   many, needs a reason and device authentication, and leaves a tombstone (C2, S4).
 * - When the API says the session has ended (401 or 403), the device is wiped only if nothing is
 *   waiting to upload. Otherwise only the unsent work is kept, encrypted, for its owner to sign in
 *   again and send, for at most `mobile.held_entries_max_days`; everything else synced is
 *   cleared (HZ-006, S2, `held-work.ts`). An expired session looks the same as a revoked one.
 * - The database names its owner, checked before every connection: it is never opened for anyone
 *   else (S3).
 */

import { nextWindowChange } from "@harbour/sync/client";
import type { AbstractPowerSyncDatabase } from "@powersync/common";
import * as Crypto from "expo-crypto";
import * as ScreenCapture from "expo-screen-capture";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import { authClient, platformFetch } from "../auth/clients";
import { DELETE_UPLOAD_ISSUE_SQL } from "../care/queries";
import { appEnv } from "../config/app-env";
import { t } from "../i18n/t";
import { clearPhotoCache } from "../people/use-person-photo";
import {
  keyOptions,
  preferredKeyProtection,
  secretStore,
  tombstoneStore,
} from "../platform/secure-store";
import { resolveAutoLockMs } from "../security/auto-lock";
import {
  assertDeviceSecure,
  authenticate,
  DeviceNotSecureError,
  unlockFailureMessages,
} from "../security/biometric";
import {
  DB_ID_ITEM,
  databaseFilename,
  databaseKeyRemains,
  destroyDatabaseKey,
  loadOrCreateDatabaseKey,
} from "../security/db-key";
import { type DeviceIntegrityResult, stubIntegrityChecker } from "../security/device-integrity";
import { IdleTimer } from "../security/idle-timer";
import { HarbourConnector } from "../sync/connector";
import {
  databaseFileGone,
  deleteDatabaseFile,
  EncryptionUnavailableError,
  openDatabase,
} from "../sync/database";
import { seedDemoDatabase } from "../sync/demo-seed";
import {
  HELD_FAIL_SAFE_DAYS,
  heldDeadline,
  heldTimeState,
  readCachedHeldMaxDays,
  resolveHeldMaxDays,
} from "../sync/held-limit";
import { ageOutRefusedContent, resolveOfflineWindow } from "../sync/offline-window";
import {
  checkDeviceOwner,
  countPendingWork,
  DiscardIncompleteError,
  discardHeldWork,
  type HeldWork,
  HeldWorkOwnerError,
  type HoldDb,
  handleSessionEnded,
  holdUnsentWork,
  ownerOf,
  readDeviceOwner,
  restoreHeldWork,
  totalPending,
  writeDeviceOwner,
} from "./held-work";
import { usePreferences } from "./preferences";
import { useSession } from "./session";
import { recordTombstone, type Tombstone } from "./tombstones";

export type VaultStatus = "locked" | "unlocking" | "unlocked";

export type ResyncResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface VaultValue {
  readonly status: VaultStatus;
  readonly error: string | null;
  readonly db: AbstractPowerSyncDatabase | null;
  /** In demo mode, when the demo data was seeded (shown in place of a last sync time). */
  readonly demoSeededAt: Date | null;
  readonly integrity: DeviceIntegrityResult | null;
  readonly autoLockMs: number;
  /** Days of entries kept on the device (`mobile.offline_window_days`), once known. */
  readonly offlineWindowDays: number | null;
  /** Shown once after the data on the device had to be reset. */
  readonly resetNotice: string | null;
  unlock(): Promise<void>;
  lock(): void;
  /** Records user activity for the idle timer. */
  touch(): void;
  retrySync(): Promise<void>;
  forceResync(): Promise<ResyncResult>;
  signOutAndWipe(notice?: string): Promise<void>;
  /**
   * Counts what has not reached the server: queued, refused and held entries. Null while the
   * database is closed (a cold-start lock), when the count cannot be known.
   */
  countUnsent(): Promise<number | null>;
  /**
   * Sign-out that deletes entries which have not reached the server (C2): needs a reason and
   * device authentication, and leaves a tombstone (S4).
   */
  signOutDiscarding(reason: string, count: number | null): Promise<void>;
  /**
   * "Sign out and delete N unsent entries" on held entries: device authentication, a reason and a
   * tombstone (S4), then the file and key are deleted and checked (S5).
   */
  discardHeld(reason: string): Promise<void>;
  /** Removes one refused entry: device authentication, a reason and a tombstone (S4, C1). */
  removeRefused(id: string, reason: string): Promise<void>;
  dismissResetNotice(): void;
}

const VaultContext = createContext<VaultValue | null>(null);

export const REMOTE_WIPE_NOTICE =
  "You were signed out of Harbour on this device, so the care records stored on it have been removed. Sign in again to continue.";

const RESET_NOTICE =
  "This device's security settings changed, so the data stored on it was reset. It will download again when you are online.";

const SIGN_OUT_TIMEOUT_MS = 5_000;

/** Device authentication before deleting entries that never reached the server (S4). */
async function confirmIdentity(): Promise<void> {
  const result = await authenticate(t("mobile.discard.authPrompt"));
  if (!result.ok) throw new Error(unlockFailureMessages[result.reason]);
}

function tombstoneId(): string {
  return Crypto.randomUUID();
}

/** How often to check whether the offline window has moved on (a UTC day boundary passed). */
const WINDOW_CHECK_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
  if (
    error instanceof DeviceNotSecureError ||
    error instanceof EncryptionUnavailableError ||
    error instanceof HeldWorkOwnerError
  ) {
    return error.message;
  }
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (text.includes("cancel")) return unlockFailureMessages.cancelled;
  return "Harbour could not be unlocked. Try again, or sign out and sign in again.";
}

export function VaultProvider({ children }: { readonly children: ReactNode }) {
  const session = useSession();
  const { preferences } = usePreferences();
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [error, setError] = useState<string | null>(null);
  const [db, setDb] = useState<AbstractPowerSyncDatabase | null>(null);
  const [demoSeededAt, setDemoSeededAt] = useState<Date | null>(null);
  const [integrity, setIntegrity] = useState<DeviceIntegrityResult | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [offlineWindowDays, setOfflineWindowDays] = useState<number | null>(null);
  /** When the window the device connected with stops being current (the next UTC midnight). */
  const windowValidUntilRef = useRef<Date | null>(null);
  /** The tenant's `mobile.held_entries_max_days`, once read (S2). */
  const heldMaxDaysRef = useRef<number | null>(null);

  const dbRef = useRef<AbstractPowerSyncDatabase | null>(null);
  const filenameRef = useRef<string | null>(null);
  const connectorRef = useRef<HarbourConnector | null>(null);
  const tokenRef = useRef<string | null>(session.token);
  const tenantRef = useRef<string | null>(session.me?.tenant.id ?? null);
  const wipingRef = useRef(false);
  const busyRef = useRef(false);
  const signOutAndWipeRef = useRef<(notice?: string) => Promise<void>>(async () => undefined);
  const sessionEndedRef = useRef<() => Promise<void>>(async () => undefined);
  const meRef = useRef(session.me);
  meRef.current = session.me;

  tokenRef.current = session.token;
  tenantRef.current = session.me?.tenant.id ?? null;

  /**
   * Connects PowerSync. The offline window travels in the sync token the API mints (ADR-0011,
   * security review S1), so the device sends no parameters; it reads the tenant's
   * `mobile.offline_window_days` only to say how many days it keeps (HZ-028).
   */
  const connectSync = useCallback(
    async (database: AbstractPowerSyncDatabase, connector: HarbourConnector) => {
      const token = tokenRef.current;
      const tenantId = tenantRef.current;
      const now = new Date();
      const window = await resolveOfflineWindow(
        database,
        token && tenantId ? { apiUrl: appEnv.apiUrl, fetch: platformFetch, token, tenantId } : null,
      );
      setOfflineWindowDays(window.days);
      windowValidUntilRef.current = nextWindowChange(now);
      heldMaxDaysRef.current = await resolveHeldMaxDays(
        database,
        token && tenantId ? { apiUrl: appEnv.apiUrl, fetch: platformFetch, token, tenantId } : null,
      ).catch(() => heldMaxDaysRef.current);
      await ageOutRefusedContent(database, now, window.days).catch(() => undefined);
      await database.connect(connector);
    },
    [],
  );

  const autoLockMs = resolveAutoLockMs(preferences.deviceMode, preferences.sharedAutoLockMs);

  const lock = useCallback(() => {
    setStatus((current) => (current === "unlocked" ? "locked" : current));
  }, []);

  const idleRef = useRef<IdleTimer | null>(null);
  if (idleRef.current === null) {
    idleRef.current = new IdleTimer({
      timeoutMs: autoLockMs,
      clock: { now: () => Date.now() },
      scheduler: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      onIdle: () => lock(),
    });
  }
  const idle = idleRef.current;

  useEffect(() => {
    idle.setTimeoutMs(autoLockMs);
  }, [idle, autoLockMs]);

  useEffect(() => {
    if (status === "unlocked") idle.start();
    else idle.stop();
  }, [idle, status]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") idle.foreground();
      else if (next === "background") idle.background();
    });
    return () => subscription.remove();
  }, [idle]);

  // iOS: blur the app-switcher snapshot whenever someone is signed in (Android uses FLAG_SECURE).
  useEffect(() => {
    if (Platform.OS !== "ios" || session.phase !== "signedIn") return;
    ScreenCapture.enableAppSwitcherProtectionAsync(1).catch(() => undefined);
    return () => {
      ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => undefined);
    };
  }, [session.phase]);

  const openVault = useCallback(
    async (afterWipe = false): Promise<void> => {
      await assertDeviceSecure();
      const { key, created, previousId } = await loadOrCreateDatabaseKey({
        store: secretStore,
        randomBytes: (length) => Crypto.getRandomBytes(length),
        options: keyOptions,
        preferredProtection: preferredKeyProtection(),
      });
      if (key.protection === "passcode") {
        // The keystore read did not prompt, so ask for the passcode explicitly.
        const result = await authenticate("Unlock Harbour");
        if (!result.ok) throw new Error(unlockFailureMessages[result.reason]);
      }
      if (created && previousId) {
        deleteDatabaseFile(databaseFilename(previousId, appEnv.demoMode));
        setResetNotice(RESET_NOTICE);
      }

      const filename = databaseFilename(key.id, appEnv.demoMode);
      const opened = await openDatabase({
        filename,
        encryptionKey: key.sqlcipherKey,
        demo: appEnv.demoMode,
      });
      dbRef.current = opened;
      filenameRef.current = filename;

      if (appEnv.demoMode) {
        setDemoSeededAt(await seedDemoDatabase(opened));
      } else {
        // S3: the database names its owner, checked before the device connects.
        const me = meRef.current;
        if (!me) throw new HeldWorkOwnerError();
        const stored = await readDeviceOwner(opened);
        const check = checkDeviceOwner(stored, me, created);
        if (check === "claim") await writeDeviceOwner(opened, ownerOf(me));
        if (check === "other") {
          const counts = await countPendingWork(opened).catch(() => null);
          if (counts && totalPending(counts) === 0) {
            // Nobody's unsent work: delete it and start a fresh database for this person.
            await closeAndDeleteRef.current(true);
            await destroyDatabaseKey(secretStore, keyOptions);
            if (afterWipe) throw new Error(t("mobile.vault.resetFailed"));
            return openVaultRef.current(true);
          }
          // Someone else's unsent work, or an owner that cannot be read: hold it for them and
          // refuse this sign-in. It is never opened for the next person.
          const now = new Date();
          const days = (await readCachedHeldMaxDays(opened)) ?? HELD_FAIL_SAFE_DAYS;
          await holdUnsentWork(opened as unknown as HoldDb, now).catch(() => 0);
          await closeKeepingDataRef.current();
          const owner = stored && stored !== "unreadable" ? stored : null;
          const token = tokenRef.current;
          if (token) void authClient.signOut(token).catch(() => undefined);
          await session.holdSession(
            {
              tenantId: owner?.tenantId ?? "",
              tenantUserId: owner?.tenantUserId ?? null,
              userId: owner?.userId ?? "",
              ownerName: owner?.name ?? null,
              entries: counts ? totalPending(counts) : null,
              heldAt: now.toISOString(),
              expiresAt: heldDeadline(now, days).toISOString(),
            },
            t("mobile.held.otherUser"),
          );
          throw new HeldWorkOwnerError();
        }
        // The owner is back: held entries go into the upload queue again before connecting.
        await restoreHeldWork(opened as unknown as HoldDb, new Date()).catch(() => undefined);
        const connector = new HarbourConnector({
          apiUrl: appEnv.apiUrl,
          fetch: platformFetch,
          getToken: async () => tokenRef.current,
          onSessionRevoked: () => {
            void sessionEndedRef.current();
          },
        });
        connectorRef.current = connector;
        connectSync(opened, connector).catch(() => undefined);
        session.refreshMe().then((result) => {
          if (result === "ended") void sessionEndedRef.current();
        });
      }
      setDb(opened);
      stubIntegrityChecker.check().then(setIntegrity, () => undefined);
    },
    [session.refreshMe, session.holdSession, connectSync],
  );
  const openVaultRef = useRef(openVault);
  openVaultRef.current = openVault;

  const unlock = useCallback(async () => {
    if (busyRef.current || session.phase !== "signedIn") return;
    busyRef.current = true;
    setStatus("unlocking");
    setError(null);
    try {
      if (!dbRef.current) {
        await openVault();
      } else {
        const result = await authenticate("Unlock Harbour");
        if (!result.ok) throw new Error(unlockFailureMessages[result.reason]);
      }
      setStatus("unlocked");
    } catch (caught) {
      setError(
        caught instanceof Error && Object.values(unlockFailureMessages).includes(caught.message)
          ? caught.message
          : errorMessage(caught),
      );
      setStatus("locked");
    } finally {
      busyRef.current = false;
    }
  }, [openVault, session.phase]);

  const closeAndDeleteRef = useRef<(clear: boolean) => Promise<void>>(async () => undefined);
  const closeKeepingDataRef = useRef<() => Promise<void>>(async () => undefined);

  const closeAndDelete = useCallback(async (clear: boolean) => {
    const current = dbRef.current;
    const filename = filenameRef.current;
    dbRef.current = null;
    filenameRef.current = null;
    connectorRef.current = null;
    setDb(null);
    if (current) {
      if (clear) await current.disconnectAndClear({ clearLocal: true }).catch(() => undefined);
      await current.close().catch(() => undefined);
    }
    if (filename) deleteDatabaseFile(filename);
  }, []);
  closeAndDeleteRef.current = closeAndDelete;

  const signOutAndWipe = useCallback(
    async (notice?: string) => {
      if (wipingRef.current) return;
      wipingRef.current = true;
      try {
        idle.stop();
        setStatus("locked");
        const token = tokenRef.current;
        if (token && !notice) {
          // Best effort: revoke the session on the server, but never wait long for it.
          await Promise.race([
            authClient.signOut(token),
            new Promise((resolve) => setTimeout(resolve, SIGN_OUT_TIMEOUT_MS)),
          ]);
        }
        await closeAndDelete(true);
        await destroyDatabaseKey(secretStore, keyOptions);
        await session.clearHeld();
        clearPhotoCache();
        setDemoSeededAt(null);
        setIntegrity(null);
        setOfflineWindowDays(null);
        windowValidUntilRef.current = null;
        setError(null);
        await session.clearSession(notice);
      } finally {
        wipingRef.current = false;
      }
    },
    [closeAndDelete, idle, session.clearSession, session.clearHeld],
  );
  signOutAndWipeRef.current = signOutAndWipe;

  /** Stops syncing and closes the database, keeping the file and its key (HZ-006). */
  const closeKeepingData = useCallback(async () => {
    const current = dbRef.current;
    dbRef.current = null;
    filenameRef.current = null;
    connectorRef.current = null;
    setDb(null);
    if (current) {
      await current.disconnect().catch(() => undefined);
      await current.close().catch(() => undefined);
    }
  }, []);
  closeKeepingDataRef.current = closeKeepingData;

  const holdingRef = useRef(false);

  /**
   * The API says the session has ended. With nothing unsent the device is wiped as before; with
   * entries waiting, uploads stop and the encrypted database is kept for its owner (HZ-006).
   */
  const sessionEnded = useCallback(async () => {
    if (wipingRef.current || holdingRef.current) return;
    holdingRef.current = true;
    try {
      const current = dbRef.current;
      const now = new Date();
      const days =
        heldMaxDaysRef.current ??
        (current ? await readCachedHeldMaxDays(current) : null) ??
        HELD_FAIL_SAFE_DAYS;
      await handleSessionEnded({
        countPending: async () => (current ? countPendingWork(current) : null),
        owner: meRef.current,
        now,
        expiresAt: heldDeadline(now, days),
        wipe: () => signOutAndWipe(REMOTE_WIPE_NOTICE),
        hold: async (held: HeldWork) => {
          idle.stop();
          setStatus("locked");
          // Only the unsent work stays (S2). If the copy fails, the whole database stays
          // encrypted rather than losing entries.
          if (current) await holdUnsentWork(current as unknown as HoldDb, now).catch(() => 0);
          await closeKeepingData();
          clearPhotoCache();
          setOfflineWindowDays(null);
          windowValidUntilRef.current = null;
          setError(null);
          await session.holdSession(held);
        },
      });
    } finally {
      holdingRef.current = false;
    }
  }, [closeKeepingData, idle, session.holdSession, signOutAndWipe]);
  sessionEndedRef.current = sessionEnded;

  const countUnsent = useCallback(async (): Promise<number | null> => {
    const current = dbRef.current;
    if (!current) return null;
    const counts = await countPendingWork(current).catch(() => null);
    return counts ? totalPending(counts) : null;
  }, []);

  const signOutDiscarding = useCallback(
    async (reason: string, count: number | null) => {
      await confirmIdentity();
      const me = meRef.current;
      await recordTombstone(
        tombstoneStore,
        {
          kind: "signed_out_with_unsent",
          tenantId: me?.tenant.id ?? null,
          ownerTenantUserId: me?.tenantUserId ?? null,
          count,
          recordIds: [],
          reason,
          at: new Date().toISOString(),
        },
        tombstoneId(),
      );
      await signOutAndWipe();
    },
    [signOutAndWipe],
  );

  /** Deletes the held entries for good, checking the file and key are gone (S5). */
  const deleteHeld = useCallback(
    async (tombstone: Tombstone) => {
      await closeKeepingData();
      await discardHeldWork({
        readDatabaseId: () => secretStore.getItem(DB_ID_ITEM, keyOptions.plainOptions),
        deleteDatabaseFile,
        destroyKey: () => destroyDatabaseKey(secretStore, keyOptions),
        databaseGone: databaseFileGone,
        keyRemains: () => databaseKeyRemains(secretStore, keyOptions),
        recordTombstone: (stone) => recordTombstone(tombstoneStore, stone, tombstoneId()),
        tombstone,
        clearHeld: session.clearHeld,
        demo: appEnv.demoMode,
      });
      clearPhotoCache();
      setError(null);
    },
    [closeKeepingData, session.clearHeld],
  );

  const discardHeld = useCallback(
    async (reason: string) => {
      await confirmIdentity();
      const held = session.held;
      await deleteHeld({
        kind: "held_deleted",
        tenantId: held?.tenantId || null,
        ownerTenantUserId: held?.tenantUserId ?? null,
        count: held?.entries ?? null,
        recordIds: [],
        reason,
        at: new Date().toISOString(),
      });
      // A full sign-out: the kept app mode goes too, so the next person starts fresh.
      await session.clearSession();
    },
    [deleteHeld, session.held, session.clearSession],
  );

  const removeRefused = useCallback(async (id: string, reason: string) => {
    await confirmIdentity();
    const current = dbRef.current;
    const me = meRef.current;
    if (!current || !me) throw new Error(t("mobile.discard.notOpen"));
    await recordTombstone(
      tombstoneStore,
      {
        kind: "refused_removed",
        tenantId: me.tenant.id,
        ownerTenantUserId: me.tenantUserId,
        count: 1,
        recordIds: [id],
        reason,
        at: new Date().toISOString(),
      },
      tombstoneId(),
    );
    await current.execute(DELETE_UPLOAD_ISSUE_SQL, [me.tenant.id, id]);
  }, []);

  // A hold that has run its time is deleted (S2): the final warning on the sign-in screen named
  // the count during its last day; the notice afterwards says what was deleted and whose it was.
  const expiringRef = useRef(false);
  useEffect(() => {
    const held = session.held;
    if (session.phase !== "signedOut" || !held) return;
    const check = () => {
      if (expiringRef.current || heldTimeState(held.expiresAt, new Date()) !== "expired") return;
      expiringRef.current = true;
      deleteHeld({
        kind: "held_expired",
        tenantId: held.tenantId || null,
        ownerTenantUserId: held.tenantUserId,
        count: held.entries,
        recordIds: [],
        reason: t("mobile.held.expiredReason"),
        at: new Date().toISOString(),
      })
        .then(() =>
          session.clearSession(
            held.entries === null
              ? t("mobile.held.expiredNoticeUnknown")
              : t("mobile.held.expiredNotice", {
                  count: held.entries,
                  name: held.ownerName ?? t("mobile.held.someone"),
                }),
          ),
        )
        .catch((caught: unknown) => {
          setError(
            caught instanceof DiscardIncompleteError
              ? caught.message
              : t("mobile.held.discardIncomplete"),
          );
        })
        .finally(() => {
          expiringRef.current = false;
        });
    };
    check();
    const interval = setInterval(check, WINDOW_CHECK_MS);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") check();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [session.phase, session.held, session.clearSession, deleteHeld]);

  const retrySync = useCallback(async () => {
    const current = dbRef.current;
    const connector = connectorRef.current;
    if (!current || !connector) return;
    await current.disconnect().catch(() => undefined);
    connectSync(current, connector).catch(() => undefined);
  }, [connectSync]);

  // The window moves at UTC midnight: once the day has changed since the last connection, reconnect
  // with the new days, so the oldest day's entries leave the device on time (ADR-0011). Checked on
  // return to the foreground and every few minutes, because long timers do not run in the
  // background.
  useEffect(() => {
    if (appEnv.demoMode) return;
    const check = () => {
      const connectedUntil = windowValidUntilRef.current;
      if (connectedUntil && Date.now() >= connectedUntil.getTime()) void retrySync();
    };
    const interval = setInterval(check, WINDOW_CHECK_MS);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") check();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [retrySync]);

  const forceResync = useCallback(async (): Promise<ResyncResult> => {
    const current = dbRef.current;
    if (!current) return { ok: false, reason: "Unlock Harbour first." };
    const queue = await current.getUploadQueueStats();
    if (queue.count > 0) {
      return {
        ok: false,
        reason:
          queue.count === 1
            ? "1 change has not uploaded yet. Connect to the internet and wait for it to upload, then try again."
            : `${queue.count} changes have not uploaded yet. Connect to the internet and wait for them to upload, then try again.`,
      };
    }
    await current.disconnectAndClear({ clearLocal: appEnv.demoMode });
    if (appEnv.demoMode) {
      setDemoSeededAt(await seedDemoDatabase(current));
    } else if (connectorRef.current) {
      connectSync(current, connectorRef.current).catch(() => undefined);
    }
    return { ok: true };
  }, [connectSync]);

  // A remote sign-out can arrive while locked; make sure nothing stays open after the session ends.
  // Held entries (HZ-006) keep their file: the database is only closed.
  useEffect(() => {
    if (session.phase !== "signedOut" || !dbRef.current) return;
    if (session.held) void closeKeepingData();
    else void closeAndDelete(true);
  }, [session.phase, session.held, closeAndDelete, closeKeepingData]);

  const touch = useCallback(() => idle.touch(), [idle]);
  const dismissResetNotice = useCallback(() => setResetNotice(null), []);

  const value = useMemo<VaultValue>(
    () => ({
      status,
      error,
      db,
      demoSeededAt,
      integrity,
      autoLockMs,
      offlineWindowDays,
      resetNotice,
      unlock,
      lock,
      touch,
      retrySync,
      forceResync,
      signOutAndWipe,
      countUnsent,
      signOutDiscarding,
      discardHeld,
      removeRefused,
      dismissResetNotice,
    }),
    [
      status,
      error,
      db,
      demoSeededAt,
      integrity,
      autoLockMs,
      offlineWindowDays,
      resetNotice,
      unlock,
      lock,
      touch,
      retrySync,
      forceResync,
      signOutAndWipe,
      countUnsent,
      signOutDiscarding,
      discardHeld,
      removeRefused,
      dismissResetNotice,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultValue {
  const value = useContext(VaultContext);
  if (!value) throw new Error("useVault must be used inside VaultProvider");
  return value;
}
