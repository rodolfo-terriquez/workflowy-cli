import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { parseLlmDocResponse } from "../shared/nodes.ts";
import { getNodeById, getCacheNodeCount, getCacheAgeSeconds, isCacheStale, markTargetDirty } from "../shared/cache.ts";
import { isDirectId, findByNameOrPath, resolveTargetReference } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerNodeMove(program: Command): void {
  program
    .command("node:move <nodeId> <target>")
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

        const resolvedNodeId = await resolveNodeArg(nodeId, api);
        if (target.startsWith("@") && target.includes("/") && getCacheNodeCount() === 0) {
          exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first for path-based targets.");
        }

        const resolved = resolveTargetReference(target);
        if (!resolved) {
          exitWithError("node_not_found", `Target "${target}" could not be resolved`, "Run `wf cache:sync` to refresh path lookups");
        }
        const hasCache = getCacheNodeCount() > 0;

        if (hasCache) {
          const cached = getNodeById(resolvedNodeId);
          if (cached?.parent_id) {
            await api.readDoc(cached.parent_id, 1);
            await api.editDoc(cached.parent_id, [{
              op: "move",
              ref: resolvedNodeId,
              under: resolved.id,
              position: opts.position as "top" | "bottom",
            }]);
          } else {
            await moveLive(api, resolvedNodeId, resolved.id, opts.position);
          }
        } else {
          await moveLive(api, resolvedNodeId, resolved.id, opts.position);
        }

        if (hasCache) {
          const cached = getNodeById(resolvedNodeId);
          if (cached?.parent_id) markTargetDirty(cached.parent_id);
        }
        markTargetDirty(resolved.id);

        const useJson = opts.format === "json" || isAgentMode();
        const cacheAge = getCacheAgeSeconds();

        if (useJson) {
          const config = loadConfig();
          const meta: Record<string, unknown> = {
            command: "node:move",
            target,
            resolved_id: resolved.id,
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.0.2",
          };
          if (cacheAge !== null) {
            meta.cache_age_seconds = cacheAge;
            meta.cache_stale = isCacheStale();
          }
          console.log(formatJson({ meta, message: `Moved ${resolvedNodeId} to ${resolved.label}` }));
        } else {
          console.log(`\n  ${chalk.green("✓")} Moved ${chalk.dim(resolvedNodeId)} → ${chalk.cyan(resolved.label)}\n`);
        }
      }
    );
}

async function moveLive(
  api: WorkflowyAPI,
  nodeId: string,
  destId: string,
  position: string
): Promise<void> {
  const nodeRaw = await api.readDoc(nodeId, 0);
  const { node: srcNode, ancestors } = parseLlmDocResponse(nodeRaw as Record<string, unknown>);
  const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1]!.id : "None";

  await api.readDoc(parentId, 1);
  await api.editDoc(parentId, [{
    op: "move",
    ref: srcNode.id,
    under: destId,
    position: position as "top" | "bottom",
  }]);
}

async function resolveNodeArg(input: string, api: WorkflowyAPI): Promise<string> {
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
