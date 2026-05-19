import { expect, test } from "bun:test";
import {
  DEFAULT_EXPORT_MIN_INTERVAL_MS,
  DEFAULT_REQUESTS_PER_MINUTE,
  RATE_LIMIT_BUCKET_MS,
  extractRetryAfterMs,
  getRequiredRateLimitDelayMs,
  normalizeRateLimitState,
  recordRateLimitHit,
  reserveRateLimitSlot,
  type RateLimitSettings,
} from "./rate-limit.ts";

const SETTINGS: RateLimitSettings = {
  requestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE,
  exportMinIntervalMs: DEFAULT_EXPORT_MIN_INTERVAL_MS,
  maxRetries: 4,
  lockStaleMs: 30_000,
  lockPollMs: 250,
};

test("general bucket starts delaying once the request budget is exhausted", () => {
  const now = 1_000_000;
  let state = normalizeRateLimitState();

  for (let i = 0; i < SETTINGS.requestsPerMinute; i++) {
    state = reserveRateLimitSlot(state, "general", SETTINGS, now);
  }

  expect(getRequiredRateLimitDelayMs(state, "general", SETTINGS, now)).toBe(RATE_LIMIT_BUCKET_MS);
  expect(getRequiredRateLimitDelayMs(state, "general", SETTINGS, now + RATE_LIMIT_BUCKET_MS)).toBe(0);
});

test("export reservations enforce a minimum interval between full exports", () => {
  const now = 2_000_000;
  const state = reserveRateLimitSlot(undefined, "export", SETTINGS, now);

  expect(getRequiredRateLimitDelayMs(state, "export", SETTINGS, now)).toBe(DEFAULT_EXPORT_MIN_INTERVAL_MS);
  expect(getRequiredRateLimitDelayMs(state, "export", SETTINGS, now + DEFAULT_EXPORT_MIN_INTERVAL_MS)).toBe(0);
});

test("server retry_after extends the block window", () => {
  const now = 3_000_000;
  const state = recordRateLimitHit(undefined, "general", SETTINGS, 15_000, now);

  expect(getRequiredRateLimitDelayMs(state, "general", SETTINGS, now)).toBe(RATE_LIMIT_BUCKET_MS);
  expect(getRequiredRateLimitDelayMs(state, "general", SETTINGS, now + RATE_LIMIT_BUCKET_MS)).toBe(0);
});

test("extractRetryAfterMs prefers header then JSON body and falls back to the bucket window", () => {
  expect(extractRetryAfterMs("12", "{\"retry_after\":31}")).toBe(12_000);
  expect(extractRetryAfterMs(null, "{\"retry_after\":31}")).toBe(31_000);
  expect(extractRetryAfterMs(null, "not-json")).toBe(RATE_LIMIT_BUCKET_MS);
});
