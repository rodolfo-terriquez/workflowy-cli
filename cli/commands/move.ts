import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { resolveTarget } from "../targets.ts";
import { parseLlmDocResponse } from "../shared/nodes.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerMove(program: Command): void {
  program
    .command("move <nodeId> <target>")
    .description("Move a node to a different parent")
    .option("--position <pos>", "Position: top or bottom", "top")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        nodeId: string,
        target: string,
        opts: { position: string; format?: string }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);
        const resolved = resolveTarget(target);

        // Step 1: read the node to discover its current parent
        const nodeRaw = await api.readDoc(nodeId, 0);
        const { node: srcNode, ancestors } = parseLlmDocResponse(nodeRaw as Record<string, unknown>);
        const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1]!.id : "None";

        // Step 2: read the parent — this establishes the session context required for editDoc
        await api.readDoc(parentId, 1);

        await api.editDoc(parentId, [
          {
            op: "move",
            ref: srcNode.id,
            under: resolved.id,
            position: opts.position as "top" | "bottom",
          },
        ]);

        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          const config = loadConfig();
          console.log(
            formatJson({
              meta: {
                command: "move",
                target,
                resolved_id: resolved.id,
                timestamp: new Date().toISOString(),
                account: config.activeAccount,
              },
              message: `Moved ${nodeId} to ${resolved.label}`,
            })
          );
        } else {
          console.log(
            `\n  ${chalk.green("✓")} Moved ${chalk.dim(nodeId)} → ${chalk.cyan(resolved.label)}\n`
          );
        }
      }
    );
}
