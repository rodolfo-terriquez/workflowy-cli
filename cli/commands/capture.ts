import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { resolveTarget } from "../targets.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerCapture(program: Command): void {
  program
    .command("capture <text>")
    .description("Add a new item to the inbox (or a specified target)")
    .option("--to <target>", "Target to capture to", "@inbox")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        text: string,
        opts: { to: string; format?: string }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);
        const resolved = resolveTarget(opts.to);

        await api.editDoc(resolved.id, [
          {
            op: "insert",
            under: resolved.id,
            items: [{ n: text }],
            position: "top",
          },
        ]);

        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          const config = loadConfig();
          console.log(
            formatJson({
              meta: {
                command: "capture",
                target: opts.to,
                resolved_id: resolved.id,
                timestamp: new Date().toISOString(),
                account: config.activeAccount,
              },
              message: `Captured to ${resolved.label}`,
            })
          );
        } else {
          console.log(
            `\n  ${chalk.green("✓")} Captured to ${chalk.cyan(resolved.label)}: ${text}\n`
          );
        }
      }
    );
}
