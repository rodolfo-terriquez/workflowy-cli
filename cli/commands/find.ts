import type { Command } from "commander";
import chalk from "chalk";
import { findByNameOrPath } from "../shared/path.ts";
import { buildBreadcrumbDisplay, getCacheNodeCount, getCacheAgeSeconds, isCacheStale } from "../shared/cache.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { formatJson } from "../output/json.ts";
import { formatTsv, formatCsv, type TsvRow } from "../shared/output-formats.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import { loadConfig } from "../shared/config.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";

export function registerNodeFind(program: Command): void {
  program
    .command("node:find <pathOrName>")
    .description("Find nodes by name or path (uses local cache)")
    .option("--format <type>", "Output format (outline|json|tsv|csv)")
    .option("--copy", "Copy output to clipboard")
    .action(async (pathOrName: string, opts: { format?: string; copy?: boolean }) => {
      if (opts.copy) startOutputCapture();

      if (getCacheNodeCount() === 0) {
        exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first to populate the local cache.");
      }

      const matches = findByNameOrPath(pathOrName);
      const format = opts.format ?? (isAgentMode() ? "json" : "outline");

      if (matches.length === 0) {
        exitWithError(
          "node_not_found",
          `No node found matching "${pathOrName}"`,
          `Run wf search '${pathOrName}' for a broader search`
        );
      }

      if (format === "tsv" || format === "csv") {
        const rows: TsvRow[] = matches.map((m) => ({
          id: m.id,
          name: cleanHtml(m.name),
          note: m.note ? cleanHtml(m.note) : "",
          type: (m.line_type as string) ?? "bullet",
          completed: m.completed === 1 ? "true" : "false",
          parent_path: m.parent_id ? buildBreadcrumbDisplay(m.parent_id) : "(root)",
        }));
        console.log(format === "tsv" ? formatTsv(rows) : formatCsv(rows));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      if (format === "json") {
        const config = loadConfig();
        const cacheAge = getCacheAgeSeconds();
        console.log(formatJson({
          meta: {
            command: "node:find",
            target: pathOrName,
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            cache_age_seconds: cacheAge,
            cache_stale: isCacheStale(),
            wf_version: "3.0.11",
          },
          nodes: matches.map((m) => ({
            id: m.id,
            name: cleanHtml(m.name),
            note: m.note ? cleanHtml(m.note) : null,
            type: (m.line_type as "bullet" | "todo") ?? "bullet",
            completed: m.completed === 1,
            parent_path: m.parent_id ? buildBreadcrumbDisplay(m.parent_id) : "(root)",
            hasMore: false,
            children: [],
          })),
        }));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      console.log(
        chalk.dim(`\n  ${matches.length} match${matches.length !== 1 ? "es" : ""}:\n`)
      );

      for (const m of matches) {
        const name = cleanHtml(m.name);
        const path = m.parent_id ? buildBreadcrumbDisplay(m.parent_id) : "(root)";
        console.log(`  ${chalk.dim(m.id)}  ${name}`);
        console.log(`  ${chalk.dim("Path:")} ${chalk.dim(path)}\n`);
      }

      await handleCopyFlag(!!opts.copy);
    });
}
