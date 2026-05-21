import type { Command } from "commander";
import chalk from "chalk";
import { getCacheDb, getCacheNodeCount, getCacheAgeSeconds, isCacheStale, buildBreadcrumbDisplay, getSubtreeIds, type CachedNode } from "../shared/cache.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { formatJson } from "../output/json.ts";
import { formatTsv, formatCsv, type TsvRow } from "../shared/output-formats.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import { loadConfig } from "../shared/config.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";
import { resolveCacheTargetReference } from "../shared/path.ts";

function parseSince(s: string): number {
  const match = s.match(/^(\d+)(m|h|d)$/);
  if (!match) return 30 * 60 * 1000;
  const n = Number(match[1]);
  switch (match[2]) {
    case "m": return n * 60 * 1000;
    case "h": return n * 3600 * 1000;
    case "d": return n * 86400 * 1000;
    default: return 30 * 60 * 1000;
  }
}

export function registerNodeTodos(program: Command): void {
  program
    .command("node:todos")
    .description("Query open or completed todos")
    .option("--target <target>", "Scope to a subtree (e.g. @today)")
    .option("--completed", "Show completed todos instead of incomplete")
    .option("--since <duration>", "Only show items modified in last N (e.g. 2h, 7d)")
    .option("--limit <n>", "Max results", parseInt)
    .option("--format <type>", "Output format (outline|json|tsv|csv)")
    .option("--copy", "Copy output to clipboard")
    .action(async (opts: {
      target?: string;
      completed?: boolean;
      since?: string;
      limit?: number;
      format?: string;
      copy?: boolean;
    }) => {
      if (opts.copy) startOutputCapture();

      if (getCacheNodeCount() === 0) {
        exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first.");
      }

      const db = getCacheDb();
      const completed = opts.completed ? 1 : 0;
      const limit = opts.limit ?? 50;

      let subtreeIds: Set<string> | null = null;
      if (opts.target) {
        const resolved = resolveCacheTargetReference(opts.target);
        if (!resolved) {
          exitWithError("node_not_found", `Target "${opts.target}" not found in cache`, "Run `wf cache:sync` to refresh path and subtree lookups");
        }
        subtreeIds = getSubtreeIds(resolved.id);
      }

      let query = `SELECT * FROM nodes WHERE completed = ? AND line_type = 'todo'`;
      const params: (string | number)[] = [completed];

      if (opts.since) {
        const cutoff = Date.now() - parseSince(opts.since);
        query += ` AND modified_at > ?`;
        params.push(Math.floor(cutoff / 1000));
      }

      query += ` ORDER BY priority, name LIMIT ?`;
      params.push(limit * 5);

      let rows = db.query(query).all(...params) as CachedNode[];

      if (subtreeIds) {
        rows = rows.filter((r) => subtreeIds!.has(r.id));
      }

      rows = rows.slice(0, limit);

      const format = opts.format ?? (isAgentMode() ? "json" : "outline");

      if (format === "tsv" || format === "csv") {
        const tsvRows: TsvRow[] = rows.map((r) => ({
          id: r.id,
          name: cleanHtml(r.name),
          note: r.note ? cleanHtml(r.note) : "",
          type: "todo",
          completed: r.completed === 1 ? "true" : "false",
          parent_path: r.parent_id ? buildBreadcrumbDisplay(r.parent_id) : "(root)",
        }));
        console.log(format === "tsv" ? formatTsv(tsvRows) : formatCsv(tsvRows));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      if (format === "json") {
        const config = loadConfig();
        const cacheAge = getCacheAgeSeconds();
        console.log(formatJson({
          meta: {
            command: "node:todos",
            target: opts.target ?? null,
            count: rows.length,
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            cache_age_seconds: cacheAge,
            cache_stale: isCacheStale(),
            wf_version: "3.0.6",
          },
          nodes: rows.map((r) => ({
            id: r.id,
            name: cleanHtml(r.name),
            note: r.note ? cleanHtml(r.note) : null,
            type: "todo",
            completed: r.completed === 1,
            parent_path: r.parent_id ? buildBreadcrumbDisplay(r.parent_id) : "(root)",
          })),
        }));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      // Outline
      const label = opts.completed ? "completed" : "open";
      const cacheAge = getCacheAgeSeconds();
      const ageStr = cacheAge ? `${Math.floor(cacheAge / 60)}m` : "?";

      console.log(`\n  ${rows.length} ${label} todos  ${chalk.dim(`(cache: ${ageStr} old)`)}\n`);

      for (const r of rows) {
        const name = cleanHtml(r.name);
        const icon = r.completed === 1 ? chalk.green("✓") : chalk.yellow("☐");
        const path = r.parent_id ? buildBreadcrumbDisplay(r.parent_id) : "(root)";
        console.log(`  ${icon} ${name}  ${chalk.dim(path)}`);
      }

      console.log("");
      await handleCopyFlag(!!opts.copy);
    });
}
