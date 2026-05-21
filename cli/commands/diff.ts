import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken } from "../shared/config.ts";
import {
  getCacheDb,
  getCacheNodeCount,
  replaceAllNodes,
} from "../shared/cache.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerCacheDiff(program: Command): void {
  program
    .command("cache:diff")
    .description("Show what changed since last sync")
    .option("--since <duration>", "Only show changes within this window (e.g. 30m, 2h)")
    .action(async (opts: { since?: string }) => {
      if (getCacheNodeCount() === 0) {
        exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first.");
      }

      const token = requireToken();
      const api = new WorkflowyAPI(token);

      const db = getCacheDb();
      const oldNodes = new Map<string, { name: string; note: string | null; completed: number; parent_id: string | null }>();

      const all = db.query("SELECT id, name, note, completed, parent_id FROM nodes").all() as Array<{
        id: string; name: string; note: string | null; completed: number; parent_id: string | null;
      }>;
      for (const row of all) {
        oldNodes.set(row.id, row);
      }

      if (!isAgentMode()) process.stdout.write(chalk.dim("  Fetching latest from API..."));

      const freshNodes = await api.exportAll();
      const { syncedAt } = replaceAllNodes(freshNodes);

      const sinceMs = opts.since ? parseDuration(opts.since) : null;
      const cutoff = sinceMs ? Date.now() - sinceMs : 0;

      const newNodeMap = new Map<string, typeof freshNodes[0]>();
      for (const n of freshNodes) {
        newNodeMap.set(n.id, n);
      }

      const added: Array<{ id: string; name: string }> = [];
      const modified: Array<{ id: string; name: string; changes: string[] }> = [];
      const deleted: Array<{ id: string; name: string }> = [];

      for (const n of freshNodes) {
        if (sinceMs && n.modifiedAt && n.modifiedAt * 1000 < cutoff) continue;

        const old = oldNodes.get(n.id);
        if (!old) {
          added.push({ id: n.id, name: n.name });
        } else {
          const changes: string[] = [];
          if (old.name !== n.name) changes.push("name");
          if ((old.note ?? "") !== (n.note ?? "")) changes.push("note");
          if (old.completed !== (n.completedAt ? 1 : 0)) changes.push("completed");
          if (old.parent_id !== (n.parent_id ?? null)) changes.push("moved");
          if (changes.length > 0) {
            modified.push({ id: n.id, name: n.name, changes });
          }
        }
      }

      for (const [id, old] of oldNodes) {
        if (!newNodeMap.has(id)) {
          deleted.push({ id, name: old.name });
        }
      }

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "cache:diff", timestamp: new Date().toISOString(), since: opts.since ?? null, wf_version: "3.0.1" },
          added: added.map((a) => ({ id: a.id, name: cleanHtml(a.name) })),
          modified: modified.map((m) => ({ id: m.id, name: cleanHtml(m.name), changes: m.changes })),
          deleted: deleted.map((d) => ({ id: d.id, name: cleanHtml(d.name) })),
          summary: { added: added.length, modified: modified.length, deleted: deleted.length },
        }, null, 2));
        return;
      }

      process.stdout.write("\r");
      const total = added.length + modified.length + deleted.length;

      if (total === 0) {
        console.log(`  ${chalk.green("✓")} No changes since last sync.\n`);
        return;
      }

      console.log(`  ${total} change${total !== 1 ? "s" : ""} found:\n`);

      for (const a of added.slice(0, 15)) {
        console.log(`  ${chalk.green("+")} ${cleanHtml(a.name)}  ${chalk.dim(a.id)}`);
      }
      if (added.length > 15) console.log(chalk.dim(`  ...and ${added.length - 15} more added`));

      for (const m of modified.slice(0, 15)) {
        console.log(`  ${chalk.yellow("~")} ${cleanHtml(m.name)}  ${chalk.dim(`(${m.changes.join(", ")})`)}`);
      }
      if (modified.length > 15) console.log(chalk.dim(`  ...and ${modified.length - 15} more modified`));

      for (const d of deleted.slice(0, 15)) {
        console.log(`  ${chalk.red("-")} ${cleanHtml(d.name)}  ${chalk.dim(d.id)}`);
      }
      if (deleted.length > 15) console.log(chalk.dim(`  ...and ${deleted.length - 15} more deleted`));

      console.log("");
    });
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 30 * 60 * 1000;
  const n = Number(match[1]);
  switch (match[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 3600 * 1000;
    case "d": return n * 86400 * 1000;
    default: return 30 * 60 * 1000;
  }
}
