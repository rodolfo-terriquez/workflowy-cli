import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { normalizeNode, type FlatNode } from "../shared/nodes.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("Search nodes by text content")
    .option("--tag <tag>", "Filter by tag")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        query: string,
        opts: { tag?: string; format?: string }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);

        const allNodes = await api.exportAll();
        const queryLower = query.toLowerCase();

        let results: FlatNode[] = allNodes
          .filter(
            (n) =>
              n.name.toLowerCase().includes(queryLower) ||
              (n.note && n.note.toLowerCase().includes(queryLower))
          )
          .map((n) => normalizeNode(n));

        if (opts.tag) {
          const tag = opts.tag.startsWith("#") ? opts.tag : `#${opts.tag}`;
          results = results.filter(
            (n) =>
              n.name.includes(tag) ||
              (n.note && n.note.includes(tag))
          );
        }

        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          const config = loadConfig();
          console.log(
            formatJson({
              meta: {
                command: "search",
                target: query,
                timestamp: new Date().toISOString(),
                account: config.activeAccount,
              },
              nodes: results,
            })
          );
        } else {
          if (results.length === 0) {
            console.log(chalk.dim(`\n  No results for "${query}"\n`));
            return;
          }

          console.log(
            chalk.dim(
              `\n  ${results.length} result${results.length !== 1 ? "s" : ""} for "${query}":\n`
            )
          );

          for (const node of results) {
            const bullet = node.completed
              ? chalk.green("✓")
              : node.type === "todo"
                ? chalk.yellow("☐")
                : chalk.dim("•");
            const name = node.name.replace(
              new RegExp(`(${escapeRegex(query)})`, "gi"),
              chalk.yellow("$1")
            );
            console.log(`  ${bullet} ${name}  ${chalk.dim(node.id)}`);
            if (node.note) {
              console.log(`    ${chalk.dim(node.note)}`);
            }
          }

          console.log("");
        }
      }
    );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
