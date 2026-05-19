import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfigDir, loadConfig } from "./config.ts";

export const RATE_LIMIT_BUCKET_MS = 60_000;
export const DEFAULT_REQUESTS_PER_MINUTE = 45;
export const DEFAULT_EXPORT_MIN_INTERVAL_MS = 65_000;
export const DEFAULT_MAX_RETRIES = 4;

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 250;
const RETRY_JITTER_MS = 250;

export type RateLimitEndpoint = "general" | "export";

export interface RateLimitSettings {
  requestsPerMinute: number;
  exportMinIntervalMs: number;
  maxRetries: number;
  lockStaleMs: number;
  lockPollMs: number;
}

export interface RateLimitState {
  windowStartedAt: number;
  windowCount: number;
  blockedUntil: number;
  exportNextAt: number;
}

interface RawRateLimitSettings {
  requestsPerMinute?: unknown;
  exportMinIntervalSeconds?: unknown;
  maxRetries?: unknown;
}

const EMPTY_STATE: RateLimitState = {
  windowStartedAt: 0,
  windowCount: 0,
  blockedUntil: 0,
  exportNextAt: 0,
};

export function getRateLimitSettings(): RateLimitSettings {
  const raw = ((loadConfig().api?.rateLimit ?? {}) as RawRateLimitSettings);

  const requestsPerMinute = toPositiveInt(raw.requestsPerMinute, DEFAULT_REQUESTS_PER_MINUTE);
  const exportMinIntervalSeconds = toPositiveInt(
    raw.exportMinIntervalSeconds,
    Math.ceil(DEFAULT_EXPORT_MIN_INTERVAL_MS / 1000),
  );
  const maxRetries = toPositiveInt(raw.maxRetries, DEFAULT_MAX_RETRIES);

  return {
    requestsPerMinute,
    exportMinIntervalMs: exportMinIntervalSeconds * 1000,
    maxRetries,
    lockStaleMs: DEFAULT_LOCK_STALE_MS,
    lockPollMs: DEFAULT_LOCK_POLL_MS,
  };
}

export function getMinimumWatchIntervalMs(): number {
  return getRateLimitSettings().exportMinIntervalMs;
}

export function normalizeRateLimitState(state?: Partial<RateLimitState> | null): RateLimitState {
  return {
    windowStartedAt: toNonNegativeInt(state?.windowStartedAt, 0),
    windowCount: toNonNegativeInt(state?.windowCount, 0),
    blockedUntil: toNonNegativeInt(state?.blockedUntil, 0),
    exportNextAt: toNonNegativeInt(state?.exportNextAt, 0),
  };
}

export function getRequiredRateLimitDelayMs(
  state: Partial<RateLimitState> | null | undefined,
  endpoint: RateLimitEndpoint,
  settings: RateLimitSettings,
  now: number,
): number {
  const normalized = refreshWindow(normalizeRateLimitState(state), now);
  let waitUntil = normalized.blockedUntil;

  if (normalized.windowCount >= settings.requestsPerMinute && normalized.windowStartedAt > 0) {
    waitUntil = Math.max(waitUntil, normalized.windowStartedAt + RATE_LIMIT_BUCKET_MS);
  }

  if (endpoint === "export") {
    waitUntil = Math.max(waitUntil, normalized.exportNextAt);
  }

  return Math.max(0, waitUntil - now);
}

export function reserveRateLimitSlot(
  state: Partial<RateLimitState> | null | undefined,
  endpoint: RateLimitEndpoint,
  settings: RateLimitSettings,
  now: number,
): RateLimitState {
  const normalized = refreshWindow(normalizeRateLimitState(state), now);
  const reserved: RateLimitState = {
    ...normalized,
    windowStartedAt: normalized.windowStartedAt || now,
    windowCount: normalized.windowCount + 1,
  };

  if (endpoint === "export") {
    reserved.exportNextAt = Math.max(reserved.exportNextAt, now + settings.exportMinIntervalMs);
  }

  return reserved;
}

export function recordRateLimitHit(
  state: Partial<RateLimitState> | null | undefined,
  endpoint: RateLimitEndpoint,
  settings: RateLimitSettings,
  retryAfterMs: number,
  now: number,
): RateLimitState {
  const normalized = refreshWindow(normalizeRateLimitState(state), now);
  const blockedUntil = now + Math.max(retryAfterMs, RATE_LIMIT_BUCKET_MS);

  return {
    ...normalized,
    blockedUntil: Math.max(normalized.blockedUntil, blockedUntil),
    exportNextAt: endpoint === "export"
      ? Math.max(normalized.exportNextAt, blockedUntil, now + settings.exportMinIntervalMs)
      : normalized.exportNextAt,
  };
}

export async function waitForRateLimitSlot(accountName: string, endpoint: RateLimitEndpoint): Promise<void> {
  while (true) {
    const settings = getRateLimitSettings();
    let delayMs = 0;

    withRateLimitLock(accountName, settings, () => {
      const state = readRateLimitState(accountName);
      const now = Date.now();
      delayMs = getRequiredRateLimitDelayMs(state, endpoint, settings, now);

      if (delayMs === 0) {
        writeRateLimitState(accountName, reserveRateLimitSlot(state, endpoint, settings, now));
      }
    });

    if (delayMs === 0) {
      return;
    }

    await Bun.sleep(delayMs + jitterMs());
  }
}

export async function noteRateLimitHit(
  accountName: string,
  endpoint: RateLimitEndpoint,
  retryAfterMs: number,
): Promise<void> {
  const settings = getRateLimitSettings();

  withRateLimitLock(accountName, settings, () => {
    const state = readRateLimitState(accountName);
    writeRateLimitState(accountName, recordRateLimitHit(state, endpoint, settings, retryAfterMs, Date.now()));
  });
}

export function extractRetryAfterMs(retryAfterHeader: string | null, responseBody: string): number {
  const headerValue = Number(retryAfterHeader);
  if (Number.isFinite(headerValue) && headerValue > 0) {
    return Math.ceil(headerValue * 1000);
  }

  try {
    const parsed = JSON.parse(responseBody) as { retry_after?: unknown };
    const retryAfter = Number(parsed.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.ceil(retryAfter * 1000);
    }
  } catch {
    // ignore malformed JSON
  }

  return RATE_LIMIT_BUCKET_MS;
}

function refreshWindow(state: RateLimitState, now: number): RateLimitState {
  if (state.windowStartedAt === 0) return state;
  if (now < state.windowStartedAt + RATE_LIMIT_BUCKET_MS) return state;

  return {
    ...state,
    windowStartedAt: now,
    windowCount: 0,
  };
}

function readRateLimitState(accountName: string): RateLimitState {
  const statePath = getStatePath(accountName);
  if (!existsSync(statePath)) return EMPTY_STATE;

  try {
    return normalizeRateLimitState(JSON.parse(readFileSync(statePath, "utf-8")) as Partial<RateLimitState>);
  } catch {
    return EMPTY_STATE;
  }
}

function writeRateLimitState(accountName: string, state: RateLimitState): void {
  ensureRateLimitDir();
  writeFileSync(getStatePath(accountName), JSON.stringify(state), "utf-8");
}

function withRateLimitLock<T>(
  accountName: string,
  settings: RateLimitSettings,
  action: () => T,
): T {
  ensureRateLimitDir();
  const lockPath = getLockPath(accountName);

  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      if (isStaleLock(lockPath, settings.lockStaleMs)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      Bun.sleepSync(settings.lockPollMs);
    }
  }

  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function ensureRateLimitDir(): void {
  const dir = getRateLimitDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getRateLimitDir(): string {
  return join(getConfigDir(), "rate-limit");
}

function getStatePath(accountName: string): string {
  return join(getRateLimitDir(), `${sanitizeAccountName(accountName)}.json`);
}

function getLockPath(accountName: string): string {
  return join(getRateLimitDir(), `${sanitizeAccountName(accountName)}.lock`);
}

function sanitizeAccountName(accountName: string): string {
  return accountName.replace(/[^a-z0-9_-]/gi, "_");
}

function isStaleLock(lockPath: string, staleMs: number): boolean {
  try {
    const stats = statSync(lockPath);
    return Date.now() - stats.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function jitterMs(): number {
  return Math.floor(Math.random() * RETRY_JITTER_MS);
}
