import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken } from "../shared/config.ts";
import { getCacheNodeCount, getNodeById, markTargetDirty } from "../shared/cache.ts";
import { isDirectId, findByNameOrPath } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { buildWriteSuccessOutput } from "../shared/write-response.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerNodeComplete(program: Command): void {
  program
    .command("node:complete <nodeIdOrPath>")
    .description("Mark a todo as complete")
    .option("--undo", "Uncheck the todo")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        nodeIdOrPath: string,
        opts: { undo?: boolean; format?: string }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);

        const nodeId = resolveNodeArg(nodeIdOrPath);

        await api.readDoc(nodeId, 1);
        await api.editDoc(nodeId, [
          {
            op: "update",
            ref: nodeId,
            to: { x: opts.undo ? 0 : 1 },
          },
        ]);

        const cached = getCacheNodeCount() > 0 ? getNodeById(nodeId) : null;
        markTargetDirty(nodeId);
        if (cached?.parent_id) {
          markTargetDirty(cached.parent_id);
        }
        const action = opts.undo ? "Uncompleted" : "Completed";
        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          console.log(formatJson(buildWriteSuccessOutput({
            command: "node:complete",
            target: nodeIdOrPath,
            resolvedId: nodeId,
            message: `${action} ${nodeId}`,
            affectedNodeIds: [nodeId],
            dirtyNodeIds: [nodeId, cached?.parent_id],
            details: {
              node_id: nodeId,
              parent_id: cached?.parent_id,
              completed: !opts.undo,
            },
          })));
        } else {
          const icon = opts.undo ? chalk.yellow("☐") : chalk.green("✓");
          console.log(`\n  ${icon} ${action} ${chalk.dim(nodeId)}\n`);
        }
      }
    );
}

function resolveNodeArg(input: string): string {
  if (isDirectId(input)) return input;

  if (getCacheNodeCount() > 0) {
    const matches = findByNameOrPath(input);
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      exitWithError(
        "ambiguous_target",
        `"${input}" matches ${matches.length} nodes`,
        `Use a node ID. Candidates: ${matches.slice(0, 3).map((m) => m.id).join(", ")}`
      );
    }
  }

  exitWithError("node_not_found", `Node "${input}" not found`, "Use a hex node ID or run `wf cache:sync` first for path resolution");
}
