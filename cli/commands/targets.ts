import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { listAllTargets } from "../targets.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerTargets(program: Command): void {
  program
    .command("targets")
    .description("List all available @targets (system + shortcuts)")
    .option("--format <type>", "Output format (outline|json)")
    .action(async (opts: { format?: string }) => {
      const token = requireToken();
      const api = new WorkflowyAPI(token);
      const targets = await listAllTargets(api);
      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        const config = loadConfig();
        console.log(
          formatJson({
            meta: {
              command: "targets",
              timestamp: new Date().toISOString(),
              account: config.activeAccount,
            },
            nodes: targets.map((t) => ({
              id: t.key,
              name: cleanHtml(t.name ?? t.key),
              note: null,
              type: "bullet" as const,
              completed: false,
              hasMore: false,
              children: [],
            })),
          })
        );
        return;
      }

      console.log("");
      for (const t of targets) {
        const tag = chalk.cyan(`@${t.key}`.padEnd(16));
        const typeLabel =
          t.type === "system"
            ? chalk.dim("[system]")
            : chalk.dim("[shortcut]");
        const name = t.name ? `  ${cleanHtml(t.name)}` : "";
        console.log(`  ${tag} ${typeLabel}${name}`);
      }
      console.log("");
    });
}
