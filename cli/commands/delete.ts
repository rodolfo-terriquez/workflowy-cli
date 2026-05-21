import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { getCacheNodeCount, getCacheAgeSeconds, isCacheStale, markTargetDirty, getNodeById } from "../shared/cache.ts";
import { parseLlmDocResponse } from "../shared/nodes.ts";
import { isDirectId, findByNameOrPath } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerNodeDelete(program: Command): void {
  program
    .command("node:delete <nodeIdOrPath>")
    .description("Delete a node")
    .option("--format <type>", "Output format (outline|json)")
    .option("--yes", "Skip confirmation prompt")
    .action(
      async (
        nodeIdOrPath: string,
        opts: { format?: string; yes?: boolean }
      ) => {
        const nodeId = resolveNodeArg(nodeIdOrPath);
        await confirmDelete(nodeIdOrPath, nodeId, !!opts.yes);

        const token = requireToken();
        const api = new WorkflowyAPI(token);
        const parentId = await resolveDeleteRootId(api, nodeId);

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
            wf_version: "3.0.2",
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

async function resolveDeleteRootId(api: WorkflowyAPI, nodeId: string): Promise<string> {
  const cached = getCacheNodeCount() > 0 ? getNodeById(nodeId) : null;
  if (cached?.parent_id) return cached.parent_id;

  const raw = await api.readDoc(nodeId, 0);
  const { node, ancestors } = parseLlmDocResponse(raw as Record<string, unknown>);
  const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1]!.id : null;

  if (!parentId) {
    exitWithError("invalid_target", `Node "${nodeId}" cannot be deleted from the tree root`, "Choose a non-root node.");
  }

  return parentId;
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

async function confirmDelete(target: string, nodeId: string, skipConfirmation: boolean): Promise<void> {
  if (skipConfirmation || isAgentMode()) return;

  const node = getNodeById(nodeId);
  const name = node ? node.name.replace(/<[^>]+>/g, "").trim() : target;

  exitWithError(
    "confirmation_required",
    `Refusing to delete "${name || target}" without confirmation.`,
    "Re-run with `--yes` to confirm deletion."
  );
}
