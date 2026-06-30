import type { Command } from "commander";
import chalk from "chalk";
import { getCacheDb, getCacheNodeCount, getCacheAgeSeconds, isCacheStale } from "../shared/cache.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import { loadConfig } from "../shared/config.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";
import { resolveCacheTargetReference } from "../shared/path.ts";

interface TagCount {
  tag: string;
  count: number;
}

function extractTags(text: string): string[] {
  const matches = text.match(/#[\w-]+/g);
  return matches ?? [];
}

export function registerTags(program: Command): void {
  program
    .command("tags")
    .description("List all #hashtags with occurrence counts")
    .option("--filter <pattern>", "Only tags containing this substring")
    .option("--sort <order>", "Sort by: count (default) or alpha", "count")
    .option("--target <target>", "Scope to a subtree")
    .option("--format <type>", "Output format (outline|json)")
    .option("--mentions", "Also extract @mentions")
    .option("--copy", "Copy output to clipboard")
    .action(async (opts: {
      filter?: string;
      sort?: string;
      target?: string;
      format?: string;
      mentions?: boolean;
      copy?: boolean;
    }) => {
      if (opts.copy) startOutputCapture();

      if (getCacheNodeCount() === 0) {
        exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first.");
      }

      const db = getCacheDb();
      let rows: Array<{ name: string; note: string | null }>;

      if (opts.target) {
        const resolved = resolveCacheTargetReference(opts.target);
        if (!resolved) {
          exitWithError("node_not_found", `Target "${opts.target}" not found in cache`, "Run `wf cache:sync` to refresh path and subtree lookups");
        }
        rows = db.query(`
          WITH RECURSIVE subtree(id) AS (
            SELECT id FROM nodes WHERE id = ?
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
          )
          SELECT n.name, n.note FROM nodes n JOIN subtree s ON n.id = s.id
        `).all(resolved.id) as Array<{ name: string; note: string | null }>;
      } else {
        rows = db.query("SELECT name, note FROM nodes").all() as Array<{ name: string; note: string | null }>;
      }

      const tagCounts = new Map<string, number>();
      const pattern = opts.mentions ? /(#[\w-]+|@[\w-]+)/g : /#[\w-]+/g;

      for (const row of rows) {
        const text = `${row.name} ${row.note ?? ""}`;
        const matches = text.match(pattern);
        if (matches) {
          for (const tag of matches) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
      }

      let tags: TagCount[] = Array.from(tagCounts.entries()).map(([tag, count]) => ({ tag, count }));

      if (opts.filter) {
        const filterLower = opts.filter.toLowerCase();
        tags = tags.filter((t) => t.tag.toLowerCase().includes(filterLower));
      }

      if (opts.sort === "alpha") {
        tags.sort((a, b) => a.tag.localeCompare(b.tag));
      } else {
        tags.sort((a, b) => b.count - a.count);
      }

      const format = opts.format ?? (isAgentMode() ? "json" : "outline");

      if (format === "json") {
        const config = loadConfig();
        const cacheAge = getCacheAgeSeconds();
        console.log(JSON.stringify({
          meta: {
            command: "tags",
            target: opts.target ?? null,
            count: tags.length,
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            cache_age_seconds: cacheAge,
            cache_stale: isCacheStale(),
            wf_version: "3.1.1",
          },
          tags,
        }, null, 2));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      if (tags.length === 0) {
        console.log(chalk.dim("\n  No tags found.\n"));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      console.log(`\n  Tags in your tree:\n`);
      for (const t of tags) {
        console.log(`  ${chalk.cyan(t.tag.padEnd(20))} ${chalk.dim(`${t.count} nodes`)}`);
      }
      console.log("");
      await handleCopyFlag(!!opts.copy);
    });
}
