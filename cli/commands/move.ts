import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken } from "../shared/config.ts";
import { getNodeById, getCacheNodeCount, markTargetDirty, setTargetUuid } from "../shared/cache.ts";
import { isDirectId, findByNameOrPath, resolveWriteTargetReference } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { buildWriteSuccessOutput } from "../shared/write-response.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import { isSystemTargetKey } from "../targets.ts";

export function registerNodeMove(program: Command): void {
  program
    .command("node:move <nodeId> <target>")
    .alias("move")
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

        const resolvedNodeId = resolveNodeArg(nodeId);
        if (target.startsWith("@") && target.includes("/") && getCacheNodeCount() === 0) {
          exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first for path-based targets.");
        }

        const resolved = resolveWriteTargetReference(target);
        if (!resolved) {
          exitWithError("node_not_found", `Target "${target}" could not be resolved`, "Run `wf cache:sync` to refresh path lookups");
        }
        const cached = getCacheNodeCount() > 0 ? getNodeById(resolvedNodeId) : null;
        const sourceParentId = cached
          ? cached.parent_id
          : (await api.getNode(resolvedNodeId)).parent_id ?? null;

        await api.moveNode(
          resolvedNodeId,
          resolved.id,
          opts.position as "top" | "bottom",
        );

        let destinationParentId = resolved.id;
        if (isSystemTargetKey(resolved.id)) {
          const movedNode = await api.getNode(resolvedNodeId);
          if (movedNode.parent_id) {
            destinationParentId = movedNode.parent_id;
            setTargetUuid(resolved.id, movedNode.parent_id);
          }
        }

        markTargetDirty(resolvedNodeId);
        if (sourceParentId) markTargetDirty(sourceParentId);
        markTargetDirty(resolved.id);
        markTargetDirty(destinationParentId);

        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          console.log(formatJson(buildWriteSuccessOutput({
            command: "node:move",
            target,
            resolvedId: resolved.id,
            message: `Moved ${resolvedNodeId} to ${resolved.label}`,
            affectedNodeIds: [resolvedNodeId, sourceParentId, resolved.id, destinationParentId],
            dirtyNodeIds: [resolvedNodeId, sourceParentId, resolved.id, destinationParentId],
            details: {
              moved_node_id: resolvedNodeId,
              source_parent_id: sourceParentId,
              destination_parent_id: destinationParentId,
              destination_target: destinationParentId !== resolved.id ? resolved.id : undefined,
              position: opts.position,
            },
          })));
        } else {
          console.log(`\n  ${chalk.green("✓")} Moved ${chalk.dim(resolvedNodeId)} → ${chalk.cyan(resolved.label)}\n`);
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
