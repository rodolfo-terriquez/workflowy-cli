import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { listAllTargets } from "../targets.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";

export function registerTargets(program: Command): void {
  program
    .command("targets")
    .description("List all available @targets (system + bookmarks)")
    .option("--format <type>", "Output format (outline|json)")
    .option("--copy", "Copy output to clipboard")
    .action(async (opts: { format?: string; copy?: boolean }) => {
      if (opts.copy) startOutputCapture();

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
              wf_version: "3.1.2",
            },
            nodes: targets.map((t) => ({
              id: t.key,
              kind: t.kind ?? (t.type === "system" ? "system" : "bookmark"),
              name: cleanHtml(t.name ?? t.key),
              context: t.context ?? null,
              node_id: t.nodeId ?? null,
              path: t.path ?? null,
              note: null,
              type: "bullet" as const,
              completed: false,
              hasMore: false,
              children: [],
            })),
          })
        );
        await handleCopyFlag(!!opts.copy);
        return;
      }

      console.log("");
      for (const t of targets) {
        const tag = chalk.cyan(`@${t.key}`.padEnd(16));
        const typeLabel =
          t.type === "system"
            ? chalk.dim("[system]")
            : chalk.dim("[bookmark]");
        const name = t.name ? `  ${cleanHtml(t.name)}` : "";
        console.log(`  ${tag} ${typeLabel}${name}`);
      }
      console.log("");

      await handleCopyFlag(!!opts.copy);
    });
}
