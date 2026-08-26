/**
 * In-app update.
 *
 * The app ships as a .dmg / .exe / .AppImage that nobody comes back to
 * re-download, so without this a fix reaches maybe the handful of people who
 * happen to revisit the releases page. The updater closes that gap: the
 * running app asks GitHub what the latest version is, and if it is newer it
 * fetches the signed bundle and swaps itself out.
 *
 * The trust boundary is a signature, not the transport. Every artifact is
 * signed at build time with the minisign key held in CI, and the public half
 * is compiled into the binary (tauri.conf.json → plugins.updater.pubkey). A
 * release the key did not sign is refused, so a hijacked endpoint gets you a
 * failed check rather than someone else's binary.
 *
 * What the interface has to keep straight is that "there is a new version" and
 * "you asked about it" are different events. The check runs by itself shortly
 * after launch and must stay quiet — a modal over a half-written paragraph is
 * not an improvement. It only lights the pill in the toolbar; everything past
 * that point is the user's move.
 */

import { useSyncExternalStore } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getConfig, setConfig } from './appConfig';

/** Where to send someone whose install cannot update itself (see `install`) */
export const RELEASES_URL = 'https://github.com/yuezheng2006/Mars-Editor-APP/releases/latest';

/** Version the user pressed 忽略 on — it stops lighting the toolbar pill */
const SKIP_KEY = 'update.skipped';
/** Epoch ms of the last automatic check, so a restart-heavy day is not a poll loop */
const LAST_CHECK_KEY = 'update.lastCheck';
/** How stale that has to be before launching checks again */
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Let the window finish drawing and the workspace finish loading first */
const AUTO_DELAY_MS = 4000;

export interface UpdateInfo {
  version: string;
  /** The release body from GitHub. Empty for a release published without one. */
  notes: string;
  /** ISO-ish date string as the release carries it, or null */
  date: string | null;
}

export type UpdateState =
  /** Nothing has been asked yet */
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** Checked, and this is already the newest there is */
  | { phase: 'current' }
  | { phase: 'available'; info: UpdateInfo }
  /** `total` is null until the response headers arrive */
  | { phase: 'downloading'; info: UpdateInfo; received: number; total: number | null }
  /** Installed on disk; only a restart is left */
  | { phase: 'ready'; info: UpdateInfo }
  | { phase: 'failed'; message: string; info: UpdateInfo | null };

let state: UpdateState = { phase: 'idle' };
const listeners = new Set<() => void>();

function emit(next: UpdateState): void {
  state = next;
  for (const l of listeners) l();
}

/**
 * The live handle for the pending update.
 *
 * Kept outside the state object on purpose: it is not data the interface
 * renders, it is the object `downloadAndInstall` has to be called on, and it
 * carries a Rust-side resource id that must not be treated as cloneable.
 */
let pending: Update | null = null;

/** Filled in on first read; the shell answers this instantly but not synchronously */
let currentVersion = '';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  // The one failure worth translating: a .deb / .rpm install cannot replace
  // itself, only the AppImage can. Tauri says so in English, in passing.
  if (/unsupported|not supported|appimage/i.test(raw)) {
    return '这种安装方式不支持自动更新（Linux 上只有 AppImage 可以），请到发布页下载新版本。';
  }
  return raw || '未知错误';
}

/** The version this binary is, e.g. `0.1.0`. Cached after the first call. */
export async function appVersion(): Promise<string> {
  if (!currentVersion && IS_TAURI) {
    try {
      currentVersion = await getVersion();
    } catch {
      currentVersion = '';
    }
  }
  return currentVersion;
}

/** Version the user chose to ignore, if any */
export function skippedVersion(): string | null {
  return getConfig(SKIP_KEY);
}

/** Stop the toolbar pill nagging about this one. The next release lights again. */
export function skipVersion(version: string): void {
  setConfig(SKIP_KEY, version);
  emit({ phase: 'idle' });
}

/**
 * Ask the endpoint whether there is something newer.
 *
 * `silent` is what separates the launch check from the button in settings: a
 * check nobody asked for must not report "已是最新" or, worse, a network error
 * — the app was not broken before it ran and is not broken after.
 *
 * Returns the version found, or null.
 */
export async function checkForUpdate({ silent = false } = {}): Promise<string | null> {
  if (!IS_TAURI) return null;
  // A download in flight owns the state; a stray check would stomp on it
  if (state.phase === 'downloading' || state.phase === 'ready') return null;
  if (!silent) emit({ phase: 'checking' });
  try {
    const found = await check();
    if (!found) {
      emit(silent ? { phase: 'idle' } : { phase: 'current' });
      return null;
    }
    pending = found;
    const info: UpdateInfo = {
      version: found.version,
      notes: found.body?.trim() ?? '',
      date: found.date ?? null,
    };
    // An ignored version stays ignored on the automatic pass, but pressing
    // 检查更新 by hand is a direct question and gets a direct answer
    if (silent && skippedVersion() === info.version) {
      emit({ phase: 'idle' });
      return null;
    }
    emit({ phase: 'available', info });
    return info.version;
  } catch (err) {
    if (silent) {
      // Offline at launch is the normal case, not an incident
      console.warn('自动检查更新失败', err);
      emit({ phase: 'idle' });
    } else {
      emit({ phase: 'failed', message: describe(err), info: null });
    }
    return null;
  }
}

/**
 * Download the bundle and hand it to the platform installer.
 *
 * On macOS and Linux this finishes with the new build already in place, and
 * the app keeps running as the old one until it is restarted. On Windows the
 * NSIS installer takes over and closes the app itself — which is why the
 * dialog says so before this is called.
 */
export async function downloadAndInstall(): Promise<void> {
  const update = pending;
  if (!update) return;
  // Prefer what the state already carries (a retry after a failure keeps the
  // notes on screen), and fall back to re-reading the handle
  const info: UpdateInfo =
    (state.phase === 'available' || state.phase === 'failed' ? state.info : null) ?? {
      version: update.version,
      notes: update.body?.trim() ?? '',
      date: update.date ?? null,
    };

  let received = 0;
  let total: number | null = null;
  emit({ phase: 'downloading', info, received, total });

  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? null;
          emit({ phase: 'downloading', info, received, total });
          break;
        case 'Progress':
          received += event.data.chunkLength;
          emit({ phase: 'downloading', info, received, total });
          break;
        case 'Finished':
          // Bytes are in; the installer step still has to run before 'ready'
          emit({ phase: 'downloading', info, received, total: total ?? received });
          break;
      }
    });
    emit({ phase: 'ready', info });
  } catch (err) {
    emit({ phase: 'failed', message: describe(err), info });
  }
}

/** Restart into the version just installed */
export async function restartIntoUpdate(): Promise<void> {
  await relaunch();
}

/**
 * The launch check.
 *
 * Throttled on the clock rather than on the session, because the app is
 * opened and closed several times a day and every launch asking GitHub is
 * both rude and pointless.
 */
export function scheduleAutoCheck(): void {
  if (!IS_TAURI) return;
  const last = Number(getConfig(LAST_CHECK_KEY) ?? 0);
  if (Number.isFinite(last) && Date.now() - last < AUTO_INTERVAL_MS) return;
  window.setTimeout(() => {
    setConfig(LAST_CHECK_KEY, String(Date.now()));
    void checkForUpdate({ silent: true });
  }, AUTO_DELAY_MS);
}

/** Close the transient verdicts (已是最新 / 失败) without touching a real find */
export function dismissVerdict(): void {
  if (state.phase === 'current' || state.phase === 'failed') emit({ phase: 'idle' });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}
