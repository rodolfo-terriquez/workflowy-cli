import type { Command } from "commander";
import chalk from "chalk";
import { findByNameOrPath, isDirectId } from "../shared/path.ts";
import { buildBreadcrumbDisplay, getCacheNodeCount } from "../shared/cache.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerFind(program: Command): void {
  program
    .command("find <pathOrName>")
    .description("Find nodes by name or path (uses local cache)")
    .option("--format <type>", "Output format (outline|json)")
    .action((pathOrName: string, opts: { format?: string }) => {
      if (getCacheNodeCount() === 0) {
        exitWithError("cache_empty", "Cache is empty.", "Run `wf sync` first to populate the local cache.");
      }

      const matches = findByNameOrPath(pathOrName);
      const useJson = opts.format === "json" || isAgentMode();

      if (matches.length === 0) {
        exitWithError(
          "node_not_found",
          `No node found matching "${pathOrName}"`,
          `Run wf search '${pathOrName}' for a broader search`
        );
      }

      if (useJson) {
        console.log(formatJson({
          meta: {
            command: "find",
            target: pathOrName,
            timestamp: new Date().toISOString(),
          },
          nodes: matches.map((m) => ({
            id: m.id,
            name: cleanHtml(m.name),
            note: m.note ? cleanHtml(m.note) : null,
            type: (m.line_type as "bullet" | "todo") ?? "bullet",
            completed: m.completed === 1,
            hasMore: false,
            children: [],
          })),
        }));
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
    });
}
