import type { Command } from "commander";
import chalk from "chalk";
import { getAccessHistory } from "../shared/history.ts";
import { isAgentMode } from "../agent.ts";
import { loadConfig } from "../shared/config.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";

export function registerHistory(program: Command): void {
  program
    .command("history")
    .description("Show recently accessed nodes")
    .option("--limit <n>", "Max entries", parseInt)
    .option("--format <type>", "Output format (outline|json)")
    .option("--copy", "Copy output to clipboard")
    .action(async (opts: { limit?: number; format?: string; copy?: boolean }) => {
      if (opts.copy) startOutputCapture();

      const limit = opts.limit ?? 20;
      const history = getAccessHistory().slice(0, limit);
      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        const config = loadConfig();
        console.log(JSON.stringify({
          meta: {
            command: "history",
            count: history.length,
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.2.1",
          },
          entries: history,
        }, null, 2));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      if (history.length === 0) {
        console.log(chalk.dim("\n  No history yet. Access some nodes first.\n"));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      console.log(`\n  Recently accessed:\n`);
      for (let i = 0; i < history.length; i++) {
        const entry = history[i]!;
        const num = chalk.dim(String(i + 1).padStart(3));
        const id = chalk.dim(entry.id.slice(0, 12));
        const name = entry.name;
        const path = chalk.dim(entry.path);
        console.log(`  ${num}  ${id}  ${name}  ${path}`);
      }
      console.log("");
      await handleCopyFlag(!!opts.copy);
    });
}
