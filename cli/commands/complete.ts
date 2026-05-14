import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerComplete(program: Command): void {
  program
    .command("complete <nodeId>")
    .description("Mark a todo as complete")
    .option("--undo", "Uncheck the todo")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        nodeId: string,
        opts: { undo?: boolean; format?: string }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);

        await api.readDoc(nodeId, 1);
        await api.editDoc(nodeId, [
          {
            op: "update",
            ref: nodeId,
            to: { x: opts.undo ? 0 : 1 },
          },
        ]);

        const action = opts.undo ? "Uncompleted" : "Completed";
        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          const config = loadConfig();
          console.log(
            formatJson({
              meta: {
                command: "complete",
                target: nodeId,
                resolved_id: nodeId,
                timestamp: new Date().toISOString(),
                account: config.activeAccount,
              },
              message: `${action} ${nodeId}`,
            })
          );
        } else {
          const icon = opts.undo ? chalk.yellow("☐") : chalk.green("✓");
          console.log(`\n  ${icon} ${action} ${chalk.dim(nodeId)}\n`);
        }
      }
    );
}
