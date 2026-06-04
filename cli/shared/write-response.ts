import type { JsonOutput } from "../output/json.ts";
import { getCacheAgeSeconds, isCacheStale } from "./cache.ts";
import { loadConfig } from "./config.ts";

const WF_VERSION = "3.0.9";

export function uniqueNodeIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

interface BuildWriteSuccessOutputOptions {
  command: string;
  message: string;
  target?: string;
  resolvedId?: string;
  affectedNodeIds?: Array<string | null | undefined>;
  dirtyNodeIds?: Array<string | null | undefined>;
  details?: Record<string, unknown>;
}

export function buildWriteSuccessOutput(options: BuildWriteSuccessOutputOptions): JsonOutput {
  const config = loadConfig();
  const meta: Record<string, unknown> = {
    command: options.command,
    timestamp: new Date().toISOString(),
    account: config.activeAccount,
    wf_version: WF_VERSION,
  };

  if (options.target !== undefined) {
    meta.target = options.target;
  }

  if (options.resolvedId !== undefined) {
    meta.resolved_id = options.resolvedId;
  }

  const cacheAge = getCacheAgeSeconds();
  if (cacheAge !== null) {
    meta.cache_age_seconds = cacheAge;
    meta.cache_stale = isCacheStale();
  }

  return {
    meta,
    success: true,
    message: options.message,
    affected_node_ids: uniqueNodeIds(options.affectedNodeIds ?? []),
    dirty_node_ids: uniqueNodeIds(options.dirtyNodeIds ?? []),
    ...(options.details ?? {}),
  };
}
