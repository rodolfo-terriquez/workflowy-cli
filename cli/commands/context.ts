import type { Command } from "commander";
import chalk from "chalk";
import { requireToken } from "../shared/config.ts";
import { WorkflowyAPI } from "../shared/api.ts";
import {
  getNodeById,
  getChildren,
  getTargetUuid,
  buildBreadcrumbDisplay,
  getCacheNodeCount,
  type CachedNode,
} from "../shared/cache.ts";
import { resolveTarget } from "../targets.ts";
import { resolvePathOrId, isDirectId, findByNameOrPath } from "../shared/path.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

function resolveTargetToCache(target: string): CachedNode | null {
  if (isDirectId(target)) {
    return getNodeById(target);
  }

  // @target without path — use system target → UUID mapping
  if (target.startsWith("@") && !target.includes("/")) {
    const resolved = resolveTarget(target);
    const uuid = getTargetUuid(resolved.id);
    if (uuid) return getNodeById(uuid);
    return null;
  }

  // @target/with/path — path traversal
  if (target.startsWith("@") && target.includes("/")) {
    const pathResult = resolvePathOrId(target);
    return pathResult?.node ?? null;
  }

  // Bare name — search
  const matches = findByNameOrPath(target);
  return matches.length === 1 ? matches[0]! : null;
}

export function registerContext(program: Command): void {
  program
    .command("context <target>")
    .description("Show a node with its ancestors, siblings, and children")
    .option("--format <type>", "Output format (outline|json)")
    .action((target: string, opts: { format?: string }) => {
      if (getCacheNodeCount() === 0) {
        exitWithError("cache_empty", "Cache is empty.", "Run `wf sync` first.");
      }

      const node = resolveTargetToCache(target);

      if (!node) {
        if (!isDirectId(target) && target.startsWith("@")) {
          const matches = findByNameOrPath(target);
          if (matches.length > 1) {
            exitWithError(
              "ambiguous_target",
              `"${target}" matches ${matches.length} nodes`,
              `Use a node ID or more specific path. Matches: ${matches.slice(0, 5).map((m) => `${m.id} (${cleanHtml(m.name)})`).join(", ")}`
            );
          }
        }
        exitWithError("node_not_found", `Node "${target}" not found in cache.`, "Run `wf sync` to refresh.");
      }

      const path = node.parent_id ? buildBreadcrumbDisplay(node.parent_id) : "(root)";
      const siblings = node.parent_id ? getChildren(node.parent_id) : getChildren(null);
      const children = getChildren(node.id);
      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(JSON.stringify({
          meta: {
            command: "context",
            target,
            resolved_id: node.id,
            timestamp: new Date().toISOString(),
          },
          node: {
            id: node.id,
            name: cleanHtml(node.name),
            note: node.note ? cleanHtml(node.note) : null,
            type: node.line_type ?? "bullet",
            completed: node.completed === 1,
          },
          path,
          siblings: siblings
            .filter((s) => s.id !== node.id)
            .slice(0, 10)
            .map((s) => ({
              id: s.id,
              name: cleanHtml(s.name),
              completed: s.completed === 1,
              type: s.line_type ?? "bullet",
            })),
          children: children.slice(0, 5).map((c) => ({
            id: c.id,
            name: cleanHtml(c.name),
            completed: c.completed === 1,
            type: c.line_type ?? "bullet",
          })),
          children_count: children.length,
          sibling_count: siblings.length - 1,
        }, null, 2));
        return;
      }

      const bullet = node.completed
        ? chalk.green("✓")
        : node.line_type === "todo"
          ? chalk.yellow("☐")
          : chalk.dim("•");

      console.log(`\n  ${chalk.dim("Path:")} ${path}`);
      console.log(`  ${bullet} ${chalk.bold(cleanHtml(node.name))}  ${chalk.dim("← this node")}`);
      if (node.note) console.log(`    ${chalk.dim(cleanHtml(node.note))}`);

      const otherSiblings = siblings.filter((s) => s.id !== node.id);
      if (otherSiblings.length > 0) {
        console.log(`\n  ${chalk.dim(`Siblings (${otherSiblings.length}):`)}`)
        for (const s of otherSiblings.slice(0, 5)) {
          const sb = s.completed ? chalk.green("✓") : s.line_type === "todo" ? chalk.yellow("☐") : chalk.dim("•");
          console.log(`    ${sb} ${cleanHtml(s.name)}`);
        }
        if (otherSiblings.length > 5) console.log(chalk.dim(`    ...and ${otherSiblings.length - 5} more`));
      }

      if (children.length > 0) {
        console.log(`\n  ${chalk.dim(`Children (${children.length}):`)}`)
        for (const c of children.slice(0, 5)) {
          const cb = c.completed ? chalk.green("✓") : c.line_type === "todo" ? chalk.yellow("☐") : chalk.dim("•");
          console.log(`    ${cb} ${cleanHtml(c.name)}`);
        }
        if (children.length > 5) console.log(chalk.dim(`    ...and ${children.length - 5} more`));
      } else {
        console.log(`\n  ${chalk.dim("Children: none")}`);
      }

      console.log("");
    });
}
