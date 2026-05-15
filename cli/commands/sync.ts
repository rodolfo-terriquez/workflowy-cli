import type { Command } from "commander";
import chalk from "chalk";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, getConfigDir } from "../shared/config.ts";
import {
  replaceAllNodes,
  getLastSyncedAt,
  getCacheNodeCount,
  getCacheAgeSeconds,
  getNodeById,
  setTargetUuid,
  clearAllDirtyFlags,
} from "../shared/cache.ts";
import { parseLlmDocResponse } from "../shared/nodes.ts";
import { isAgentMode } from "../agent.ts";

const SYSTEM_TARGETS = ["inbox", "today", "tomorrow", "calendar", "next_week"];

const PID_PATH = join(getConfigDir(), "sync.pid");

export function registerSync(program: Command): void {
  program
    .command("sync")
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

async function doSync(): Promise<void> {
  const token = requireToken();
  const api = new WorkflowyAPI(token);

  const start = Date.now();
  if (!isAgentMode()) process.stdout.write(chalk.dim("  Syncing..."));

  const allNodes = await api.exportAll();
  const { nodeCount, syncedAt } = replaceAllNodes(allNodes);

  clearAllDirtyFlags();
  await resolveSystemTargets(api);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "sync", timestamp: new Date().toISOString() },
      message: `Synced ${nodeCount} nodes`,
      node_count: nodeCount,
      synced_at: syncedAt,
      elapsed_seconds: Number(elapsed),
    }, null, 2));
  } else {
    process.stdout.write(`\r  ${chalk.green("✓")} Synced ${chalk.bold(String(nodeCount))} nodes in ${elapsed}s\n\n`);
  }
}

function showStatus(): void {
  const lastSynced = getLastSyncedAt();
  const nodeCount = getCacheNodeCount();
  const ageSeconds = getCacheAgeSeconds();

  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "sync --status", timestamp: new Date().toISOString() },
      last_synced_at: lastSynced,
      node_count: nodeCount,
      cache_age_seconds: ageSeconds,
      cache_stale: ageSeconds === null || ageSeconds > 300,
    }, null, 2));
    return;
  }

  console.log("");
  if (lastSynced === null) {
    console.log(`  ${chalk.yellow("⚠")} Cache is empty. Run ${chalk.cyan("wf sync")} to populate.`);
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

  const child = Bun.spawn(["bun", "run", import.meta.dir + "/../wf.ts", "sync", "--watch-loop"], {
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

async function resolveSystemTargets(api: WorkflowyAPI): Promise<void> {
  for (const target of SYSTEM_TARGETS) {
    try {
      const data = await api.readDoc(target, 0);
      const { node } = parseLlmDocResponse(data);
      if (node.id) {
        const cached = getNodeById(node.id);
        if (cached) {
          setTargetUuid(target, cached.id);
        }
      }
    } catch {
      // Some targets may not exist for this account
    }
  }
}

// Hidden subcommand for the daemon loop
export function registerSyncLoop(program: Command): void {
  program
    .command("sync --watch-loop", { hidden: true })
    .action(async () => {
      while (true) {
        try {
          await doSync();
        } catch {
          // silently retry
        }
        await Bun.sleep(5 * 60 * 1000);
      }
    });
}
