import type { Command } from "commander";
import chalk from "chalk";
import { isAgentMode } from "../agent.ts";
import { formatJson } from "../output/json.ts";
import { WorkflowyAPI, type WFNode } from "../shared/api.ts";
import { getCacheNodeCount, getNodeById, markTargetDirty } from "../shared/cache.ts";
import { getActiveAccountName, getApiEnvironment, requireToken } from "../shared/config.ts";
import { exitWithError } from "../shared/errors.ts";
import { findByNameOrPath, isDirectId, resolveTargetReference } from "../shared/path.ts";
import { APP_VERSION } from "../shared/version.ts";

type Position = "top" | "bottom";

export function registerMirrorCommands(program: Command): void {
  program
    .command("mirror:info <nodeIdOrPath>")
    .description("Show beta API mirror relationship data for a node")
    .action(async (nodeIdOrPath: string) => {
      requireBetaApi();
      const api = new WorkflowyAPI(requireToken());
      const nodeId = resolveNodeArg(nodeIdOrPath);
      const node = await api.getNode(nodeId);
      const relationship = describeMirrorRelationship(node);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: buildMeta("mirror:info", api),
          node,
          mirror: relationship,
        }, null, 2));
        return;
      }

      console.log(`\n  ${chalk.bold(node.name || node.id)}`);
      console.log(`  ${chalk.dim("Node:")}   ${node.id}`);
      console.log(`  ${chalk.dim("Role:")}   ${relationship.role}`);
      if (relationship.origin_id) console.log(`  ${chalk.dim("Origin:")} ${relationship.origin_id}`);
      if (relationship.mirror_ids.length > 0) {
        console.log(`  ${chalk.dim("Mirrors:")} ${relationship.mirror_ids.join(", ")}`);
      }
      console.log("");
    });

  program
    .command("mirror:create <nodeIdOrPath> <target>")
    .description("Create a live mirror under another node (beta public API)")
    .option("--position <pos>", "Position: top or bottom", "top")
    .action(async (nodeIdOrPath: string, target: string, opts: { position: string }) => {
      requireBetaApi();
      const position = parsePosition(opts.position);
      const sourceId = resolveNodeArg(nodeIdOrPath);
      const destination = resolveDestination(target);
      const api = new WorkflowyAPI(requireToken());
      const result = await api.createMirror(sourceId, destination.id, position);

      markTargetDirty(sourceId);
      markTargetDirty(destination.id);
      markTargetDirty(result.item_id);

      if (isAgentMode()) {
        console.log(formatJson({
          meta: buildMeta("mirror:create", api),
          message: `Created mirror ${result.item_id}`,
          mirror: {
            id: result.item_id,
            origin_id: result.origin_id,
            parent_id: destination.id,
            position,
          },
        }));
        return;
      }

      console.log(`\n  ${chalk.green("✓")} Created mirror ${chalk.dim(result.item_id)}`);
      console.log(`  ${chalk.dim("Origin:")} ${result.origin_id}`);
      console.log(`  ${chalk.dim("Under:")}  ${destination.label}\n`);
    });

  program
    .command("mirror:remove <nodeIdOrPath>")
    .description("Remove one mirror root while leaving its origin intact (beta public API)")
    .option("--yes", "Confirm removal of the mirror root")
    .action(async (nodeIdOrPath: string, opts: { yes?: boolean }) => {
      requireBetaApi();
      if (!opts.yes) {
        exitWithError(
          "confirmation_required",
          "Refusing to remove a mirror without confirmation.",
          "Re-run with `--yes` to remove only this mirror root; the origin remains intact.",
        );
      }

      const nodeId = resolveNodeArg(nodeIdOrPath);
      const cached = getCacheNodeCount() > 0 ? getNodeById(nodeId) : null;
      const api = new WorkflowyAPI(requireToken());
      await api.deleteMirror(nodeId);

      markTargetDirty(nodeId);
      if (cached?.parent_id) markTargetDirty(cached.parent_id);

      if (isAgentMode()) {
        console.log(formatJson({
          meta: buildMeta("mirror:remove", api),
          message: `Removed mirror ${nodeId}; origin was left intact`,
          removed_mirror_id: nodeId,
          origin_preserved: true,
        }));
        return;
      }

      console.log(`\n  ${chalk.green("✓")} Removed mirror ${chalk.dim(nodeId)}; origin left intact\n`);
    });
}

function buildMeta(command: string, api: WorkflowyAPI) {
  return {
    command,
    timestamp: new Date().toISOString(),
    account: getActiveAccountName(),
    api_environment: api.environment,
    api_base_url: api.publicApiBase,
    wf_version: APP_VERSION,
  };
}

function requireBetaApi(): void {
  if (getApiEnvironment() === "beta") return;
  exitWithError(
    "beta_api_required",
    "WorkFlowy mirror API support is currently available on the beta public API.",
    "Use `wf --beta ...`, `wf --api-environment beta ...`, or persist it with `wf config:set api.environment beta`.",
  );
}

function parsePosition(position: string): Position {
  if (position === "top" || position === "bottom") return position;
  exitWithError("invalid_position", `Unknown position "${position}".`, "Use top or bottom.");
}

function resolveDestination(input: string) {
  const resolved = resolveTargetReference(input);
  if (resolved) return resolved;
  exitWithError(
    "node_not_found",
    `Destination "${input}" could not be resolved to a node ID.`,
    "The mirror API requires a real destination node ID. Run `wf cache:sync` first for @targets and paths.",
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
        `"${input}" matches ${matches.length} nodes.`,
        `Use a node ID. Candidates: ${matches.slice(0, 3).map((node) => node.id).join(", ")}`,
      );
    }
  }

  exitWithError("node_not_found", `Node "${input}" not found.`, "Use a node ID or run `wf cache:sync` for path resolution.");
}

function describeMirrorRelationship(node: WFNode): {
  role: "mirror" | "origin" | "regular";
  origin_id: string | null;
  mirror_ids: string[];
} {
  const originId = node.data?.mirror?.origin_id ?? null;
  const mirrorIds = node.data?.mirror?.mirror_ids ?? [];
  return {
    role: originId !== null ? "mirror" : mirrorIds.length > 0 ? "origin" : "regular",
    origin_id: originId,
    mirror_ids: mirrorIds,
  };
}
