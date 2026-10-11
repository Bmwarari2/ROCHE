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
 *   many, needs a coded reason and device authentication, and is put on record first (C2, S4, M1).
 * - When the API says the session has ended (401, or a 403 the API marks as a session problem),
 *   the device is wiped only if nothing is waiting to upload. Otherwise only the unsent work is
 *   kept, encrypted, for its owner to sign in again and send; everything else synced is cleared
 *   (HZ-006, S2, `held-work.ts`). Held entries are never deleted automatically: after
 *   `mobile.held_entries_max_days` the hold escalates to a manager, with local notifications
 *   (HZ-040, M3, `held-limit.ts`). Deleting them needs the owner's or a manager's sign-in.
 * - The database names its owner, checked before every connection: it is never opened for anyone
 *   else (S3).
 * - Every deletion of unsent entries goes to the API as an audit event, and is sent again at each
 *   sync until the server has it; the device also reports its unsent counts (M2, queue depth).
 */

import type { SyncDeviceReport } from "@harbour/contracts";
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
import type { Me } from "../auth/auth-client";
import { authClient, platformFetch } from "../auth/clients";
import { DELETE_UPLOAD_ISSUE_SQL } from "../care/queries";
import { appEnv } from "../config/app-env";
import { t } from "../i18n/t";
import { clearPhotoCache } from "../people/use-person-photo";
import { cancelHeldNotifications, scheduleHeldNotifications } from "../platform/notifications";
import {
  DEVICE_ID_ITEM,
  keyOptions,
  preferredKeyProtection,
  readPlain,
  secretStore,
  tombstoneStore,
  writePlain,
} from "../platform/secure-store";
import { resolveAutoLockMs } from "../security/auto-lock";
import {
  assertDeviceSecure,
  authenticate,
  DeviceNotSecureError,
  unlockFailureMessages,
} from "../security/biometric";
import {
  type DatabaseKey,
  DB_ID_ITEM,
  databaseFilename,
  databaseKeyRemains,
  destroyDatabaseKey,
  loadOrCreateDatabaseKey,
  readDatabaseKey,
} from "../security/db-key";
import { type DeviceIntegrityResult, stubIntegrityChecker } from "../security/device-integrity";
import { IdleTimer } from "../security/idle-timer";
import { FAIL_SAFE_TOLERANCE_MINUTES, resolveClockTolerance } from "../sync/clock-tolerance";
import { HarbourConnector } from "../sync/connector";
import {
  databaseFileGone,
  deleteDatabaseFile,
  EncryptionUnavailableError,
  openDatabase,
} from "../sync/database";
import { seedDemoDatabase } from "../sync/demo-seed";
import {
  buildDeviceReport,
  flushPendingReport,
  type LastReport,
  PENDING_REPORT_ITEM,
  type ReportDb,
  reportOrKeep,
  reportSent,
  sendDeviceReport,
  shouldSendReport,
} from "../sync/device-report";
import {
  type ApiOptions,
  type DiscardSendResult,
  flushTombstones,
  putDiscardOnRecord,
  sendDiscard,
  withdrawDiscard,
} from "../sync/discards";
import {
  HELD_FAIL_SAFE_DAYS,
  heldDeadline,
  planHeldNotifications,
  readCachedHeldMaxDays,
  resolveHeldMaxDays,
} from "../sync/held-limit";
import { resolveOfflineWindow } from "../sync/offline-window";
import {
  admitToDatabase,
  canDiscardHeld,
  checkDiscardReason,
  countPendingWork,
  type DiscardReason,
  discardHeldWork,
  HeldDiscardNotAllowedError,
  type HeldWork,
  HeldWorkOwnerError,
  type HoldDb,
  handleSessionEnded,
  holdUnsentWork,
  readUnsentIds,
  restoreComplete,
  totalPending,
  VaultResetError,
} from "./held-work";
import { usePreferences } from "./preferences";
import { useSession } from "./session";
import {
  type DiscardKind,
  type DiscardReasonCode,
  purgeLegacyTombstones,
  type Tombstone,
} from "./tombstones";

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
  /**
   * Minutes a typed event time may be ahead of the device clock (`sync.clock_drift_flag_minutes`);
   * none until the tenant's figure is known (HZ-010).
   */
  readonly clockToleranceMinutes: number;
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
   * Sign-out that deletes entries which have not reached the server (C2): needs a coded reason and
   * device authentication, and is put on record before anything is deleted (S4, M1, M2).
   */
  signOutDiscarding(choice: DiscardReason, count: number | null): Promise<void>;
  /**
   * Deletes held entries from the sign-in screen (M2): `signerToken` is a session just signed in
   * for the purpose, by the entries' owner or a manager, never the device passcode alone. Then
   * device authentication, a record of the deletion, and the file and key deleted and checked (S5).
   * The signer's session is ended afterwards.
   */
  discardHeld(choice: DiscardReason, signerToken: string): Promise<void>;
  /** Removes one refused entry: device authentication, a coded reason, on record first (C1). */
  removeRefused(id: string, choice: DiscardReason): Promise<void>;
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

/** The coded reason, checked again here so no caller can skip it (M1). */
function requireReason(choice: DiscardReason): DiscardReasonCode {
  const problem = checkDiscardReason(choice);
  if (problem || !choice.reasonCode) {
    throw new Error(t(problem?.key ?? "mobile.discard.reasonCodeRequired", problem?.values));
  }
  return choice.reasonCode;
}

function newTombstone(
  kind: DiscardKind,
  reasonCode: DiscardReasonCode,
  fields: Pick<
    Tombstone,
    "tenantId" | "ownerTenantUserId" | "deletedByTenantUserId" | "entryIds" | "personIds" | "count"
  >,
): Tombstone {
  return { id: Crypto.randomUUID(), kind, reasonCode, at: new Date().toISOString(), ...fields };
}

async function apiFor(token: string, tenantId: string): Promise<ApiOptions> {
  return {
    apiUrl: appEnv.apiUrl,
    fetch: platformFetch,
    token,
    tenantId,
    deviceId: await readPlain(DEVICE_ID_ITEM),
  };
}

const sender =
  (options: ApiOptions | null) =>
  (tombstone: Tombstone, reason: string | null): Promise<DiscardSendResult> =>
    options ? sendDiscard(options, tombstone, reason) : Promise.resolve("retry");

/** How often to check whether the offline window has moved on, and to resend what waits. */
const WINDOW_CHECK_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
  if (
    error instanceof DeviceNotSecureError ||
    error instanceof EncryptionUnavailableError ||
    error instanceof HeldWorkOwnerError ||
    error instanceof VaultResetError
  ) {
    return error.message;
  }
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (text.includes("cancel")) return unlockFailureMessages.cancelled;
  return "Harbour could not be unlocked. Try again, or sign out and sign in again.";
}

/**
 * The held database's entry and person ids, for the record of its deletion. Reading the key shows
 * the biometric prompt, which is the device authentication; a passcode-protected key, or none,
 * asks for the passcode explicitly. The ids are best effort: the deletion goes ahead without them.
 */
async function readHeldIds(): Promise<{ entryIds: string[]; personIds: string[] } | null> {
  let key: DatabaseKey | null = null;
  try {
    key = await readDatabaseKey(secretStore, keyOptions);
  } catch {
    key = null;
  }
  if (!key || key.protection === "passcode") await confirmIdentity();
  if (!key) return null;
  try {
    const held = await openDatabase({
      filename: databaseFilename(key.id, appEnv.demoMode),
      encryptionKey: key.sqlcipherKey,
      demo: appEnv.demoMode,
    });
    try {
      return await readUnsentIds(held as unknown as HoldDb);
    } finally {
      await held.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/** A hold's report, sent now when the session allows, otherwise kept (counts only) for later. */
async function reportHold(held: HeldWork, report: SyncDeviceReport | null, token: string | null) {
  if (!report || !held.tenantId || appEnv.demoMode) return;
  const options = token ? await apiFor(token, held.tenantId) : null;
  await reportOrKeep(tombstoneStore, { tenantId: held.tenantId, report }, options).catch(
    () => undefined,
  );
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
  const [clockToleranceMinutes, setClockToleranceMinutes] = useState(FAIL_SAFE_TOLERANCE_MINUTES);
  /** When the window the device connected with stops being current (the next UTC midnight). */
  const windowValidUntilRef = useRef<Date | null>(null);
  /** The tenant's `mobile.held_entries_max_days`, once read (S2). */
  const heldMaxDaysRef = useRef<number | null>(null);

  const dbRef = useRef<AbstractPowerSyncDatabase | null>(null);
  const filenameRef = useRef<string | null>(null);
  const connectorRef = useRef<HarbourConnector | null>(null);
  const statusListenerRef = useRef<(() => void) | null>(null);
  const tokenRef = useRef<string | null>(session.token);
  const tenantRef = useRef<string | null>(session.me?.tenant.id ?? null);
  const wipingRef = useRef(false);
  const busyRef = useRef(false);
  const signOutAndWipeRef = useRef<(notice?: string) => Promise<void>>(async () => undefined);
  const sessionEndedRef = useRef<() => Promise<void>>(async () => undefined);
  const afterSyncRef = useRef<() => Promise<void>>(async () => undefined);
  const meRef = useRef<Me | null>(session.me);
  meRef.current = session.me;

  tokenRef.current = session.token;
  tenantRef.current = session.me?.tenant.id ?? null;

  useEffect(() => {
    void purgeLegacyTombstones(tombstoneStore);
  }, []);

  /** The current session, for requests the vault makes itself. */
  const currentApi = useCallback(async (): Promise<ApiOptions | null> => {
    const token = tokenRef.current;
    const tenantId = tenantRef.current;
    if (appEnv.demoMode || !token || !tenantId) return null;
    return apiFor(token, tenantId);
  }, []);

  /**
   * After each sync (and every few minutes): deletions still waiting go to the API until it has
   * them (M2), and the device's unsent counts go when they change (queue depth). Never throws.
   */
  const lastReportRef = useRef<LastReport | null>(null);
  const afterSyncBusyRef = useRef(false);
  const afterSync = useCallback(async () => {
    const current = dbRef.current;
    const options = await currentApi();
    if (!current || !options || afterSyncBusyRef.current) return;
    afterSyncBusyRef.current = true;
    try {
      await flushTombstones(tombstoneStore, options).catch(() => undefined);
      await flushPendingReport(tombstoneStore, options).catch(() => undefined);
      const now = new Date();
      const report = await buildDeviceReport(current as unknown as ReportDb, now).catch(() => null);
      if (report && shouldSendReport(lastReportRef.current, report, now)) {
        if (await sendDeviceReport(options, report))
          lastReportRef.current = reportSent(report, now);
      }
    } finally {
      afterSyncBusyRef.current = false;
    }
  }, [currentApi]);
  afterSyncRef.current = afterSync;

  const stopStatusListener = useCallback(() => {
    statusListenerRef.current?.();
    statusListenerRef.current = null;
  }, []);

  /**
   * Connects PowerSync. The offline window travels in the sync token the API mints (ADR-0011,
   * security review S1), so the device sends no parameters; it reads the tenant's
   * `mobile.offline_window_days` only to say how many days it keeps (HZ-028). Refused entries keep
   * their content until someone deals with them (clinical review M1).
   */
  const connectSync = useCallback(
    async (database: AbstractPowerSyncDatabase, connector: HarbourConnector) => {
      const token = tokenRef.current;
      const tenantId = tenantRef.current;
      const now = new Date();
      const fetchOptions =
        token && tenantId ? { apiUrl: appEnv.apiUrl, fetch: platformFetch, token, tenantId } : null;
      const window = await resolveOfflineWindow(database, fetchOptions);
      setOfflineWindowDays(window.days);
      windowValidUntilRef.current = nextWindowChange(now);
      setClockToleranceMinutes(
        await resolveClockTolerance(database, fetchOptions).catch(
          () => FAIL_SAFE_TOLERANCE_MINUTES,
        ),
      );
      heldMaxDaysRef.current = await resolveHeldMaxDays(database, fetchOptions).catch(
        () => heldMaxDaysRef.current,
      );
      stopStatusListener();
      let lastSynced = database.currentStatus.lastSyncedAt?.getTime() ?? null;
      statusListenerRef.current = database.registerListener({
        statusChanged: (next) => {
          const at = next.lastSyncedAt?.getTime() ?? null;
          if (at !== null && at !== lastSynced) {
            lastSynced = at;
            void afterSyncRef.current();
          }
        },
      });
      await database.connect(connector);
      void afterSyncRef.current();
    },
    [stopStatusListener],
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

  const closeAndDeleteRef = useRef<(clear: boolean) => Promise<void>>(async () => undefined);
  const closeKeepingDataRef = useRef<() => Promise<void>>(async () => undefined);

  const openVault = useCallback(
    async (afterReset = false): Promise<void> => {
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
        // The device's opaque id, so a deletion recorded with no database open still names it.
        await writePlain(DEVICE_ID_ITEM, await opened.getClientId()).catch(() => undefined);
        // S3: the database names its owner, checked before the device connects
        // (`admitToDatabase`, tested in held-work.test.ts).
        const now = new Date();
        const outcome = await admitToDatabase({
          db: opened as unknown as HoldDb,
          me: meRef.current,
          created,
          afterReset,
          now,
          cachedHeldMaxDays: () => readCachedHeldMaxDays(opened),
          reset: async () => {
            await closeAndDeleteRef.current(true);
            await destroyDatabaseKey(secretStore, keyOptions);
          },
          closeKeeping: () => closeKeepingDataRef.current(),
        });
        if (outcome.kind === "reopen") return openVaultRef.current(true);
        if (outcome.kind === "refused") {
          // Someone else's unsent work, or an owner that cannot be read: held for them, and this
          // sign-in is refused. It is never opened for the next person.
          const token = tokenRef.current;
          await reportHold(outcome.held, outcome.report, token);
          if (token) void authClient.signOut(token).catch(() => undefined);
          await session.holdSession(outcome.held, t("mobile.held.otherUser"));
          void scheduleHeldNotifications(planHeldNotifications(outcome.held, now));
          throw new HeldWorkOwnerError();
        }
        // The owner's held entries are back in the upload queue (or moved to "needs attention"):
        // only then does the marker go. Any still held stay counted on the banner and Today, and
        // the marker stays so the next unlock tries again (clinical review M2).
        if (restoreComplete(outcome.restore)) {
          await session.clearHeld().catch(() => undefined);
          void cancelHeldNotifications();
        }
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
    [session.refreshMe, session.holdSession, session.clearHeld, connectSync],
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

  const closeAndDelete = useCallback(
    async (clear: boolean) => {
      const current = dbRef.current;
      const filename = filenameRef.current;
      dbRef.current = null;
      filenameRef.current = null;
      connectorRef.current = null;
      stopStatusListener();
      setDb(null);
      if (current) {
        if (clear) await current.disconnectAndClear({ clearLocal: true }).catch(() => undefined);
        await current.close().catch(() => undefined);
      }
      if (filename) deleteDatabaseFile(filename);
    },
    [stopStatusListener],
  );
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
        void cancelHeldNotifications();
        clearPhotoCache();
        setDemoSeededAt(null);
        setIntegrity(null);
        setOfflineWindowDays(null);
        windowValidUntilRef.current = null;
        lastReportRef.current = null;
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
    stopStatusListener();
    setDb(null);
    if (current) {
      await current.disconnect().catch(() => undefined);
      await current.close().catch(() => undefined);
    }
  }, [stopStatusListener]);
  closeKeepingDataRef.current = closeKeepingData;

  const holdingRef = useRef(false);

  /**
   * The API says the session has ended. With nothing unsent the device is wiped as before; with
   * entries waiting, uploads stop and the encrypted database is kept for its owner (HZ-006). The
   * hold's report and notifications start here.
   */
  const sessionEnded = useCallback(async () => {
    if (wipingRef.current || holdingRef.current) return;
    holdingRef.current = true;
    try {
      const current = dbRef.current;
      const token = tokenRef.current;
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
        lastServerTime: current?.currentStatus.lastSyncedAt ?? null,
        wipe: () => signOutAndWipe(REMOTE_WIPE_NOTICE),
        hold: async (held: HeldWork) => {
          idle.stop();
          setStatus("locked");
          // Only the unsent work stays (S2). If the copy fails, the whole database stays
          // encrypted rather than losing entries.
          let report: SyncDeviceReport | null = null;
          if (current) {
            await holdUnsentWork(current as unknown as HoldDb, now).catch(() => 0);
            report = await buildDeviceReport(current as unknown as ReportDb, now).catch(() => null);
          }
          await closeKeepingData();
          clearPhotoCache();
          setOfflineWindowDays(null);
          windowValidUntilRef.current = null;
          setError(null);
          await session.holdSession(held);
          void scheduleHeldNotifications(planHeldNotifications(held, now));
          await reportHold(held, report, token);
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
    async (choice: DiscardReason, count: number | null) => {
      const reasonCode = requireReason(choice);
      await confirmIdentity();
      const me = meRef.current;
      const current = dbRef.current;
      const ids = current
        ? await readUnsentIds(current as unknown as HoldDb).catch(() => null)
        : null;
      const tombstone = newTombstone("signed_out_with_unsent", reasonCode, {
        tenantId: me?.tenant.id ?? null,
        ownerTenantUserId: me?.tenantUserId ?? null,
        deletedByTenantUserId: me?.tenantUserId ?? null,
        entryIds: ids?.entryIds ?? [],
        personIds: ids?.personIds ?? [],
        count,
      });
      // On record before anything is deleted; a failure refuses the sign-out (M1, M2, L4).
      await putDiscardOnRecord({
        store: tombstoneStore,
        tombstone,
        reason: choice.reason,
        send: sender(await currentApi()),
      });
      await signOutAndWipe();
    },
    [currentApi, signOutAndWipe],
  );

  const discardHeld = useCallback(
    async (choice: DiscardReason, signerToken: string) => {
      const held = session.held;
      try {
        if (!held) return;
        const reasonCode = requireReason(choice);
        const signer = await authClient.getMe(signerToken);
        // The owner or a manager, signed in now: not the device passcode alone (M2).
        if (!canDiscardHeld(held, signer)) throw new HeldDiscardNotAllowedError();
        const ids = await readHeldIds();
        const options = await apiFor(signerToken, signer.tenant.id);
        // The hold's own report goes first, so the server sees what was held and for how long.
        await flushPendingReport(tombstoneStore, options).catch(() => undefined);
        const tombstone = newTombstone("held_deleted", reasonCode, {
          tenantId: held.tenantId || signer.tenant.id,
          ownerTenantUserId: held.tenantUserId,
          deletedByTenantUserId: signer.tenantUserId,
          entryIds: ids?.entryIds ?? [],
          personIds: ids?.personIds ?? [],
          count: held.entries ?? (ids ? ids.entryIds.length : null),
        });
        await closeKeepingData();
        await discardHeldWork({
          readDatabaseId: () => secretStore.getItem(DB_ID_ITEM, keyOptions.plainOptions),
          deleteDatabaseFile,
          destroyKey: () => destroyDatabaseKey(secretStore, keyOptions),
          databaseGone: databaseFileGone,
          keyRemains: () => databaseKeyRemains(secretStore, keyOptions),
          putOnRecord: () =>
            putDiscardOnRecord({
              store: tombstoneStore,
              tombstone,
              reason: choice.reason,
              send: sender(options),
            }),
          withdrawRecord: () => withdrawDiscard(tombstoneStore, tombstone.id),
          clearHeld: session.clearHeld,
          demo: appEnv.demoMode,
        });
        await tombstoneStore.remove(PENDING_REPORT_ITEM).catch(() => undefined);
        void cancelHeldNotifications();
        clearPhotoCache();
        setError(null);
        // A full sign-out: the kept app mode goes too, so the next person starts fresh.
        await session.clearSession();
      } finally {
        // The signer signed in only to delete; that session ends here.
        void authClient.signOut(signerToken).catch(() => undefined);
      }
    },
    [closeKeepingData, session.held, session.clearHeld, session.clearSession],
  );

  const removeRefused = useCallback(
    async (id: string, choice: DiscardReason) => {
      const reasonCode = requireReason(choice);
      await confirmIdentity();
      const current = dbRef.current;
      const me = meRef.current;
      if (!current || !me) throw new Error(t("mobile.discard.notOpen"));
      const row = await current.getOptional<{ person_id: string | null }>(
        "SELECT person_id FROM upload_issue WHERE id = ?",
        [id],
      );
      const tombstone = newTombstone("refused_removed", reasonCode, {
        tenantId: me.tenant.id,
        ownerTenantUserId: me.tenantUserId,
        deletedByTenantUserId: me.tenantUserId,
        entryIds: [id],
        personIds: row?.person_id ? [row.person_id] : [],
        count: 1,
      });
      await putDiscardOnRecord({
        store: tombstoneStore,
        tombstone,
        reason: choice.reason,
        send: sender(await currentApi()),
      });
      await current.execute(DELETE_UPLOAD_ISSUE_SQL, [me.tenant.id, id]);
    },
    [currentApi],
  );

  // A hold escalates to a manager; nothing is deleted (M3). Local notifications mark the start of
  // its last day and the escalation; the sign-in screen shows the same.
  useEffect(() => {
    const held = session.held;
    if (session.phase !== "signedOut" || !held) return;
    void scheduleHeldNotifications(planHeldNotifications(held, new Date()));
  }, [session.phase, session.held]);

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
  // background. Deletions and reports still waiting are sent again at the same time.
  useEffect(() => {
    if (appEnv.demoMode) return;
    const check = () => {
      const connectedUntil = windowValidUntilRef.current;
      if (connectedUntil && Date.now() >= connectedUntil.getTime()) void retrySync();
      else void afterSyncRef.current();
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
      clockToleranceMinutes,
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
      clockToleranceMinutes,
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
