import type { Command } from "commander";
import chalk from "chalk";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, getConfigDir, loadConfig } from "../shared/config.ts";
import {
  replaceAllNodes,
  getLastSyncedAt,
  getCacheNodeCount,
  getCacheAgeSeconds,
  clearTargetUuid,
  getTargetUuid,
  setTargetUuid,
  clearAllDirtyFlags,
} from "../shared/cache.ts";
import { isAgentMode } from "../agent.ts";
import { parseLlmDocResponse } from "../shared/nodes.ts";
import { cacheTargets } from "../shared/db.ts";
import { buildSystemTargetMap } from "../shared/system-targets.ts";
import { normalizeTargetKey } from "../targets.ts";

const SYSTEM_TARGETS = ["inbox", "today", "tomorrow", "calendar", "next_week"] as const;

const PID_PATH = join(getConfigDir(), "sync.pid");

export function registerCacheSync(program: Command): void {
  program
    .command("cache:sync")
    .description("Sync local cache from WorkFlowy API")
    .option("--watch", "Background daemon, re-syncs every 5 min")
    .option("--status", "Show last sync time and node count")
    .option("--stop", "Stop the background sync daemon")
    .action(async (opts: { watch?: boolean; status?: boolean; stop?: boolean }) => {
      if (opts.stop) {
        stopDaemon();
        return;
      }

      if (opts.status) {
        showStatus();
        return;
      }

      if (opts.watch) {
        startDaemon();
        return;
      }

      await doSync();
    });
}

export async function doSync(): Promise<{ nodeCount: number; syncedAt: number }> {
  const token = requireToken();
  const api = new WorkflowyAPI(token);

  const start = Date.now();
  if (!isAgentMode()) process.stdout.write(chalk.dim("  Syncing..."));

  const allNodes = await api.exportAll();
  const { nodeCount, syncedAt } = replaceAllNodes(allNodes);

  clearAllDirtyFlags();
  resolveSystemTargets(allNodes);
  await refreshTargetCache(api);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "cache:sync", timestamp: new Date().toISOString(), wf_version: "3.0.2" },
      message: `Synced ${nodeCount} nodes`,
      node_count: nodeCount,
      synced_at: syncedAt,
      elapsed_seconds: Number(elapsed),
    }, null, 2));
  } else {
    process.stdout.write(`\r  ${chalk.green("✓")} Synced ${chalk.bold(String(nodeCount))} nodes in ${elapsed}s\n\n`);
  }

  return { nodeCount, syncedAt };
}

function showStatus(): void {
  const lastSynced = getLastSyncedAt();
  const nodeCount = getCacheNodeCount();
  const ageSeconds = getCacheAgeSeconds();

  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "cache:sync", mode: "status", timestamp: new Date().toISOString(), wf_version: "3.0.2" },
      last_synced_at: lastSynced,
      node_count: nodeCount,
      cache_age_seconds: ageSeconds,
      cache_stale: ageSeconds === null || ageSeconds > 300,
    }, null, 2));
    return;
  }

  console.log("");
  if (lastSynced === null) {
    console.log(`  ${chalk.yellow("⚠")} Cache is empty. Run ${chalk.cyan("wf cache:sync")} to populate.`);
  } else {
    const date = new Date(lastSynced);
    const age = formatAge(ageSeconds!);
    const stale = ageSeconds! > 300;
    console.log(`  Last synced: ${date.toLocaleString()} (${age} ago)${stale ? chalk.yellow(" ⚠ stale") : ""}`);
    console.log(`  Nodes:       ${nodeCount}`);

    if (existsSync(PID_PATH)) {
      const pid = readFileSync(PID_PATH, "utf-8").trim();
      console.log(`  Daemon:      running (PID ${pid})`);
    }
  }
  console.log("");
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function startDaemon(): void {
  if (existsSync(PID_PATH)) {
    const existingPid = readFileSync(PID_PATH, "utf-8").trim();
    try {
      process.kill(Number(existingPid), 0);
      console.log(`\n  Sync daemon already running (PID ${existingPid})\n`);
      return;
    } catch {
      unlinkSync(PID_PATH);
    }
  }

  const child = Bun.spawn(["bun", "run", import.meta.dir + "/../wf.ts", "cache:sync", "--watch-loop"], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  child.unref();
  writeFileSync(PID_PATH, String(child.pid));
  console.log(`\n  ${chalk.green("✓")} Sync daemon started (PID ${child.pid}), re-syncs every 5 min\n`);
}

function stopDaemon(): void {
  if (!existsSync(PID_PATH)) {
    console.log("\n  No sync daemon running.\n");
    return;
  }

  const pid = Number(readFileSync(PID_PATH, "utf-8").trim());
  try {
    process.kill(pid);
  } catch {
    // already dead
  }
  unlinkSync(PID_PATH);
  console.log(`\n  ${chalk.green("✓")} Sync daemon stopped.\n`);
}

function resolveSystemTargets(nodes: Awaited<ReturnType<WorkflowyAPI["exportAll"]>>): void {
  for (const target of SYSTEM_TARGETS) {
    clearTargetUuid(target);
  }

  const mappings = buildSystemTargetMap(nodes);

  for (const target of SYSTEM_TARGETS) {
    const mappedId = mappings[target];
    if (mappedId) {
      setTargetUuid(target, mappedId);
    }
  }
}

async function refreshTargetCache(api: WorkflowyAPI): Promise<void> {
  const account = loadConfig().activeAccount;
  const targets = await api.getTargets();
  const resolvedTargets = [];

  for (const target of targets) {
    let nodeId: string | null = null;

    try {
      const data = await api.readDoc(target.key, 0);
      nodeId = parseLlmDocResponse(data).node.id || null;
    } catch {
      nodeId = target.type === "system" ? getCachedSystemTargetUuid(target.key) : null;
    }

    resolvedTargets.push({
      key: normalizeTargetKey(target.key),
      label: target.name ?? target.key,
      nodeId,
      type: target.type,
    });
  }

  cacheTargets(account, resolvedTargets);
}

function getCachedSystemTargetUuid(targetKey: string): string | null {
  const normalizedKey = normalizeTargetKey(targetKey);
  return SYSTEM_TARGETS.includes(normalizedKey as (typeof SYSTEM_TARGETS)[number])
    ? getTargetUuid(normalizedKey)
    : null;
}
