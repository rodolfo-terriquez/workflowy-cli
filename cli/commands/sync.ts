import { APP_VERSION } from "../shared/version.ts";
import { Option, type Command } from "commander";
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
import { getSelfCliInvocation } from "../shared/runtime.ts";
import { exitWithError } from "../shared/errors.ts";

const SYSTEM_TARGETS = ["inbox", "today", "tomorrow", "calendar", "next_week"] as const;

const PID_PATH = join(getConfigDir(), "sync.pid");
const SYNC_WATCH_INTERVAL_MS = 5 * 60_000;

export function registerCacheSync(program: Command): void {
  program
    .command("cache:sync")
    .alias("sync")
    .description("Sync local cache from WorkFlowy API")
    .option("--watch", "Background daemon, re-syncs every 5 min")
    .option("--status", "Show last sync time and node count")
    .option("--stop", "Stop the background sync daemon")
    .addOption(new Option("--watch-loop").hideHelp())
    .action(async (opts: { watch?: boolean; status?: boolean; stop?: boolean; watchLoop?: boolean }) => {
      if (opts.watchLoop) {
        await runSyncWatchLoop();
        return;
      }

      if (opts.stop) {
        stopDaemon();
        return;
      }

      if (opts.status) {
        showStatus();
        return;
      }

      if (opts.watch) {
        await startDaemon();
        return;
      }

      await doSync();
    });
}

export async function doSync(opts: { silent?: boolean } = {}): Promise<{ nodeCount: number; syncedAt: number }> {
  const token = requireToken();
  const api = new WorkflowyAPI(token);
  const silent = opts.silent ?? false;

  const start = Date.now();
  if (!silent && !isAgentMode()) process.stdout.write(chalk.dim("  Syncing..."));

  const allNodes = await api.exportAll();
  const { nodeCount, syncedAt } = replaceAllNodes(allNodes);

  clearAllDirtyFlags();
  resolveSystemTargets(allNodes);
  await refreshTargetCache(api);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!silent) {
    if (isAgentMode()) {
      console.log(JSON.stringify({
        meta: { command: "cache:sync", timestamp: new Date().toISOString(), wf_version: APP_VERSION },
        message: `Synced ${nodeCount} nodes`,
        node_count: nodeCount,
        synced_at: syncedAt,
        elapsed_seconds: Number(elapsed),
      }, null, 2));
    } else {
      process.stdout.write(`\r  ${chalk.green("✓")} Synced ${chalk.bold(String(nodeCount))} nodes in ${elapsed}s\n\n`);
    }
  }

  return { nodeCount, syncedAt };
}

function showStatus(): void {
  const lastSynced = getLastSyncedAt();
  const nodeCount = getCacheNodeCount();
  const ageSeconds = getCacheAgeSeconds();
  const daemon = getDaemonStatus();

  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "cache:sync", mode: "status", timestamp: new Date().toISOString(), wf_version: APP_VERSION },
      last_synced_at: lastSynced,
      node_count: nodeCount,
      cache_age_seconds: ageSeconds,
      cache_stale: ageSeconds === null || ageSeconds > 300,
      daemon_running: daemon.running,
      daemon_pid: daemon.pid,
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

    if (daemon.running) {
      console.log(`  Daemon:      running (PID ${daemon.pid})`);
    } else if (daemon.stale) {
      console.log(`  Daemon:      ${chalk.yellow("not running (removed stale PID file)")}`);
    }
  }
  console.log("");
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

async function startDaemon(): Promise<void> {
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

  requireToken();

  const child = Bun.spawn(getSelfCliInvocation(["cache:sync", "--watch-loop"]), {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });

  const startup = await Promise.race([
    child.exited.then((exitCode) => ({ exited: true as const, exitCode })),
    Bun.sleep(150).then(() => ({ exited: false as const, exitCode: null })),
  ]);
  if (startup.exited) {
    exitWithError("daemon_start_failed", `Sync daemon exited during startup with status ${startup.exitCode}.`);
  }

  child.unref();
  writeFileSync(PID_PATH, String(child.pid));
  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "cache:sync", mode: "watch", wf_version: APP_VERSION },
      daemon_running: true,
      daemon_pid: child.pid,
      interval_seconds: SYNC_WATCH_INTERVAL_MS / 1000,
    }, null, 2));
  } else {
    console.log(`\n  ${chalk.green("✓")} Sync daemon started (PID ${child.pid}), re-syncs every 5 min\n`);
  }
}

async function runSyncWatchLoop(): Promise<never> {
  while (true) {
    try {
      await doSync({ silent: true });
    } catch (error) {
      console.error(`[wf sync daemon] ${error instanceof Error ? error.message : String(error)}`);
    }
    await Bun.sleep(SYNC_WATCH_INTERVAL_MS);
  }
}

function getDaemonStatus(): { running: boolean; pid: number | null; stale: boolean } {
  if (!existsSync(PID_PATH)) return { running: false, pid: null, stale: false };

  const pid = Number(readFileSync(PID_PATH, "utf-8").trim());
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return { running: true, pid, stale: false };
    } catch {
      // Remove the stale PID file below.
    }
  }

  unlinkSync(PID_PATH);
  return { running: false, pid: Number.isFinite(pid) ? pid : null, stale: true };
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
  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "cache:sync", mode: "stop", wf_version: APP_VERSION },
      daemon_running: false,
      stopped_pid: pid,
    }, null, 2));
  } else {
    console.log(`\n  ${chalk.green("✓")} Sync daemon stopped.\n`);
  }
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
