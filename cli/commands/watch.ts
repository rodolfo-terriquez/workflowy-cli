import type { Command } from "commander";
import chalk from "chalk";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { platform } from "os";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, getConfigDir } from "../shared/config.ts";
import { getCacheDb, replaceAllNodes, getCacheNodeCount } from "../shared/cache.ts";
import { resolveSavedTargetNodeId, resolveTarget } from "../targets.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import { getMinimumWatchIntervalMs } from "../shared/rate-limit.ts";

const PID_PATH = join(getConfigDir(), "watch.pid");
const WEBHOOKS_PATH = join(getConfigDir(), "webhooks.json");

interface ChangeEvent {
  event: "added" | "modified" | "deleted";
  id: string;
  name?: string;
  parent?: string | null;
  ts: string;
}

interface Webhook {
  id: string;
  filter: string;
  url: string;
  created_at: string;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadWebhooks(): Webhook[] {
  if (!existsSync(WEBHOOKS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(WEBHOOKS_PATH, "utf-8")) as Webhook[];
  } catch {
    return [];
  }
}

export function registerWatch(program: Command): void {
  program
    .command("watch:start")
    .description("Poll for changes and stream NDJSON events")
    .option("--interval <duration>", "Poll interval (e.g. 2m, 5m)", "5m")
    .option("--target <target>", "Scope to subtree")
    .option("--notify <type>", "Notification: desktop or webhook")
    .option("--format <type>", "Output format (json is NDJSON)")
    .action(async (opts: {
      interval?: string;
      target?: string;
      notify?: string;
      format?: string;
    }) => {
      const requestedInterval = opts.interval ?? "5m";
      const intervalMs = parseInterval(requestedInterval);
      const minimumIntervalMs = getMinimumWatchIntervalMs();

      if (intervalMs < minimumIntervalMs) {
        exitWithError(
          "interval_too_short",
          `Watch interval must be at least ${formatDurationMs(minimumIntervalMs)} to avoid export rate limits.`,
          `Use --interval ${formatDurationMs(minimumIntervalMs)} or longer, or adjust \`api.rateLimit.exportMinIntervalSeconds\`.`,
        );
      }

      const isTTY = process.stdout.isTTY && !isAgentMode();

      if (isTTY) {
        const extraArgs: string[] = [];
        if (opts.interval && opts.interval !== "5m") extraArgs.push("--interval", opts.interval);
        if (opts.target) extraArgs.push("--target", opts.target);
        if (opts.notify) extraArgs.push("--notify", opts.notify);
        startDaemonMode(requestedInterval, extraArgs);
        return;
      }

      await runWatchLoop(requestedInterval, opts.target, opts.notify);
    });

  program
    .command("watch:stop")
    .description("Stop the watch daemon")
    .action(() => {
      if (!existsSync(PID_PATH)) {
        console.log("\n  No watch daemon running.\n");
        return;
      }
      const pid = Number(readFileSync(PID_PATH, "utf-8").trim());
      try { process.kill(pid); } catch { /* already dead */ }
      unlinkSync(PID_PATH);
      console.log(`\n  ${chalk.green("✓")} Watch daemon stopped.\n`);
    });

  program
    .command("watch:status")
    .description("Show watch daemon status")
    .action(() => {
      if (!existsSync(PID_PATH)) {
        if (isAgentMode()) {
          console.log(JSON.stringify({ meta: { command: "watch:status", wf_version: "3.0.9" }, running: false }));
        } else {
          console.log("\n  Watch daemon: not running.\n");
        }
        return;
      }
      const pid = Number(readFileSync(PID_PATH, "utf-8").trim());
      if (Number.isNaN(pid) || !isProcessRunning(pid)) {
        unlinkSync(PID_PATH);
        if (isAgentMode()) {
          console.log(JSON.stringify({ meta: { command: "watch:status", wf_version: "3.0.9" }, running: false }));
        } else {
          console.log("\n  Watch daemon: not running.\n");
        }
        return;
      }
      if (isAgentMode()) {
        console.log(JSON.stringify({ meta: { command: "watch:status", wf_version: "3.0.9" }, running: true, pid }));
      } else {
        console.log(`\n  Watch daemon: running (PID ${pid})\n`);
      }
    });
}

function startDaemonMode(interval: string, extraArgs: string[]): void {
  if (existsSync(PID_PATH)) {
    const existingPid = readFileSync(PID_PATH, "utf-8").trim();
    try {
      process.kill(Number(existingPid), 0);
      console.log(`\n  Watch daemon already running (PID ${existingPid})\n`);
      return;
    } catch {
      unlinkSync(PID_PATH);
    }
  }

  const child = Bun.spawn(
    ["bun", "run", import.meta.dir + "/../wf.ts", "watch:start", "--interval", interval, ...extraArgs],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, WF_AGENT: "1" },
    }
  );

  child.unref();
  writeFileSync(PID_PATH, String(child.pid));
  console.log(`\n  ${chalk.green("✓")} Watch daemon started (PID ${child.pid}), polling every ${interval}\n`);
}

function parseInterval(s: string): number {
  const match = s.match(/^(\d+)(s|m|h)$/);
  if (!match) return 5 * 60 * 1000;
  const n = Number(match[1]);
  switch (match[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 3600 * 1000;
    default: return 5 * 60 * 1000;
  }
}

function formatDurationMs(ms: number): string {
  if (ms % 3600_000 === 0) return `${ms / 3600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.ceil(ms / 1000)}s`;
}

function getSubtreeIds(rootId: string): Set<string> {
  const db = getCacheDb();
  const ids = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    ids.add(current);
    const children = db.query("SELECT id FROM nodes WHERE parent_id = ?").all(current) as Array<{ id: string }>;
    for (const child of children) queue.push(child.id);
  }
  return ids;
}

async function sendDesktopNotification(title: string, body: string): Promise<void> {
  const os = platform();
  try {
    if (os === "darwin") {
      await Bun.spawn([
        "osascript", "-e",
        `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
      ]).exited;
    } else if (os === "linux") {
      await Bun.spawn(["notify-send", title, body]).exited;
    }
  } catch {
    // notification tool not available
  }
}

async function fireWebhooks(events: ChangeEvent[]): Promise<void> {
  const hooks = loadWebhooks();
  if (hooks.length === 0) return;

  for (const hook of hooks) {
    for (const event of events) {
      if (hook.filter !== "*" && !matchesFilter(hook.filter, event)) continue;
      try {
        await fetch(hook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...event, webhook_id: hook.id }),
        });
      } catch {
        // silent fail
      }
    }
  }
}

function matchesFilter(filter: string, event: ChangeEvent): boolean {
  if (filter.startsWith("tag:")) {
    const tag = filter.slice(4);
    return (event.name ?? "").includes(tag);
  }
  return true;
}

async function runWatchLoop(interval: string, target?: string, notify?: string): Promise<void> {
  const intervalMs = parseInterval(interval);
  const token = requireToken();
  const api = new WorkflowyAPI(token);

  let subtreeIds: Set<string> | null = null;

  while (true) {
    try {
      const db = getCacheDb();
      const oldNodes = new Map<string, { name: string; note: string | null; completed: number; parent_id: string | null }>();

      if (getCacheNodeCount() > 0) {
        const all = db.query("SELECT id, name, note, completed, parent_id FROM nodes").all() as Array<{
          id: string; name: string; note: string | null; completed: number; parent_id: string | null;
        }>;
        for (const row of all) oldNodes.set(row.id, row);
      }

      const freshNodes = await api.exportAll();
      replaceAllNodes(freshNodes);

      if (target && !subtreeIds) {
        const resolved = resolveTarget(target);
        const uuid = resolveSavedTargetNodeId(resolved.id) ?? resolved.id;
        subtreeIds = getSubtreeIds(uuid);
      }

      const newNodeMap = new Map(freshNodes.map((n) => [n.id, n]));
      const events: ChangeEvent[] = [];

      for (const n of freshNodes) {
        if (subtreeIds && !subtreeIds.has(n.id)) continue;

        const old = oldNodes.get(n.id);
        if (!old) {
          events.push({ event: "added", id: n.id, name: cleanHtml(n.name), parent: n.parent_id ?? null, ts: new Date().toISOString() });
        } else {
          const changed = old.name !== n.name
            || (old.note ?? "") !== (n.note ?? "")
            || old.completed !== (n.completedAt ? 1 : 0)
            || old.parent_id !== (n.parent_id ?? null);
          if (changed) {
            events.push({ event: "modified", id: n.id, name: cleanHtml(n.name), parent: n.parent_id ?? null, ts: new Date().toISOString() });
          }
        }
      }

      for (const [id, old] of oldNodes) {
        if (subtreeIds && !subtreeIds.has(id)) continue;
        if (!newNodeMap.has(id)) {
          events.push({ event: "deleted", id, name: cleanHtml(old.name), ts: new Date().toISOString() });
        }
      }

      for (const event of events) {
        console.log(JSON.stringify(event));
      }

      if (events.length > 0) {
        if (notify === "desktop") {
          const summary = events.length === 1
            ? `${events[0]!.event}: ${events[0]!.name ?? events[0]!.id}`
            : `${events.length} changes detected`;
          await sendDesktopNotification("WorkFlowy", summary);
        }
        await fireWebhooks(events);
      }

      if (target) {
        const resolved = resolveTarget(target);
        const uuid = resolveSavedTargetNodeId(resolved.id) ?? resolved.id;
        subtreeIds = getSubtreeIds(uuid);
      }
    } catch {
      // silently retry
    }

    await Bun.sleep(intervalMs);
  }
}
