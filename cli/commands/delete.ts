import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { getCacheNodeCount, getCacheAgeSeconds, isCacheStale, markTargetDirty, getNodeById } from "../shared/cache.ts";
import { isDirectId, findByNameOrPath } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerNodeDelete(program: Command): void {
  program
    .command("node:delete <nodeIdOrPath>")
    .description("Delete a node")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        nodeIdOrPath: string,
        opts: { format?: string }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);

        const nodeId = resolveNodeArg(nodeIdOrPath);

        const cached = getCacheNodeCount() > 0 ? getNodeById(nodeId) : null;
        const parentId = cached?.parent_id ?? nodeId;

        await api.readDoc(parentId, 1);
        await api.editDoc(parentId, [{ op: "delete", ref: nodeId }]);

        markTargetDirty(parentId);
        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          const config = loadConfig();
          const meta: Record<string, unknown> = {
            command: "node:delete",
            target: nodeIdOrPath,
            resolved_id: nodeId,
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.0.0",
          };
          const cacheAge = getCacheAgeSeconds();
          if (cacheAge !== null) {
            meta.cache_age_seconds = cacheAge;
            meta.cache_stale = isCacheStale();
          }
          console.log(formatJson({ meta, message: `Deleted ${nodeId}` }));
        } else {
          console.log(`\n  ${chalk.red("✗")} Deleted ${chalk.dim(nodeId)}\n`);
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

  exitWithError("node_not_found", `Node "${input}" not found`, "Use a hex node ID or run `wf cache:sync` first");
}
