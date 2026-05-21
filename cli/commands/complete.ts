import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { getCacheNodeCount, getCacheAgeSeconds, isCacheStale, markTargetDirty } from "../shared/cache.ts";
import { isDirectId, findByNameOrPath } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
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

        markTargetDirty(nodeId);
        const action = opts.undo ? "Uncompleted" : "Completed";
        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          const config = loadConfig();
          const meta: Record<string, unknown> = {
            command: "node:complete",
            target: nodeIdOrPath,
            resolved_id: nodeId,
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.0.3",
          };
          const cacheAge = getCacheAgeSeconds();
          if (cacheAge !== null) {
            meta.cache_age_seconds = cacheAge;
            meta.cache_stale = isCacheStale();
          }
          console.log(formatJson({ meta, message: `${action} ${nodeId}` }));
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
