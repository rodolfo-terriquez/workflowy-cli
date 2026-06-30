import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { parseLlmDocResponse, cleanHtml, type FlatNode } from "../shared/nodes.ts";
import { resolveSavedTargetNodeId, resolveTarget } from "../targets.ts";
import {
  getNodeById,
  getChildren,
  buildBreadcrumb,
  getCacheNodeCount,
  getCacheAgeSeconds,
  isCacheStale,
  isTargetDirty,
  clearTargetDirty,
  type CachedNode,
} from "../shared/cache.ts";
import { resolvePathOrId, isDirectId, resolveCacheTargetReference, resolveTargetReference } from "../shared/path.ts";
import { formatOutline } from "../output/compact.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { recordAccess } from "../shared/history.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";

export function registerNodeRead(program: Command): void {
  program
    .command("node:read [target]")
    .alias("read")
    .description("Read a node and its children")
    .option("--depth <n>", "Max depth to read", parseInt)
    .option("--format <type>", "Output format (outline|json)")
    .option("--live", "Force live API call (bypass cache)")
    .option("--include-path", "Include breadcrumb path in JSON output")
    .option("--copy", "Copy output to clipboard")
    .action(
      async (
        target: string | undefined,
        opts: { depth?: number; format?: string; live?: boolean; includePath?: boolean; copy?: boolean }
      ) => {
        if (opts.copy) startOutputCapture();

        const targetStr = target ?? "@inbox";
        const depth = opts.depth ?? 3;
        const useJson = opts.format === "json" || isAgentMode();
        const hasCache = getCacheNodeCount() > 0;

        const dirtyKeys = getDirtyKeys(targetStr);
        const dirty = dirtyKeys.some((key) => isTargetDirty(key));
        const useLive = opts.live || !hasCache || dirty;

        if (dirty && useLive) {
          for (const key of dirtyKeys) {
            clearTargetDirty(key);
          }
        }

        if (useLive) {
          await readLive(targetStr, depth, useJson, opts.includePath);
        } else {
          readFromCache(targetStr, depth, useJson, opts.includePath);
        }

        await handleCopyFlag(!!opts.copy);
      }
    );
}

async function readLive(
  targetStr: string,
  depth: number,
  useJson: boolean,
  includePath?: boolean
): Promise<void> {
  const token = requireToken();
  const api = new WorkflowyAPI(token);
  if (targetStr.startsWith("@") && targetStr.includes("/") && getCacheNodeCount() === 0) {
    exitNodeNotFound(targetStr, useJson, "Run `wf cache:sync` first for path-based live reads.");
  }

  const resolved = resolveTargetReference(targetStr);
  if (!resolved) {
    exitNodeNotFound(targetStr, useJson, "Run `wf cache:sync` to refresh path lookups.");
  }

  const data = await api.readDoc(resolved.id, depth);
  const { node, ancestors } = parseLlmDocResponse(data);

  recordAccess({
    id: node.id,
    name: node.name,
    path: ancestors.map((a) => a.name).join(" > ") || "(root)",
  });

  if (useJson) {
    const config = loadConfig();
    const meta: Record<string, unknown> = {
      command: "node:read",
      target: targetStr,
      resolved_id: resolved.id,
      timestamp: new Date().toISOString(),
      account: config.activeAccount,
      source: "live",
      wf_version: "3.1.1",
    };

    const output: Record<string, unknown> = {
      meta,
      node: { id: node.id, name: node.name, note: node.note, type: node.type, completed: node.completed, hasMore: false, children: [] },
      children: node.children,
    };

    if (includePath && ancestors.length > 0) {
      (output as Record<string, unknown>).path = ancestors.map((a) => a.name).join(" > ");
    }

    console.log(formatJson(output));
  } else {
    if (ancestors.length > 0) {
      const breadcrumb = ancestors.map((a) => a.name).join(chalk.dim(" > "));
      console.log(`\n  ${chalk.dim(breadcrumb)}`);
    }
    console.log("");
    console.log(formatOutline(node, depth));
    console.log("");
  }
}

function getDirtyKeys(targetStr: string): string[] {
  const keys = new Set<string>();

  if (targetStr.startsWith("@")) {
    const rootTarget = targetStr.split("/")[0]!;
    keys.add(resolveTarget(rootTarget).id);
  }

  const cacheResolved = resolveCacheTargetReference(targetStr);
  if (cacheResolved) {
    keys.add(cacheResolved.id);
  }

  return [...keys];
}

function exitNodeNotFound(target: string, useJson: boolean, hint?: string): never {
  const msg = `No node found matching "${target}"`;
  if (useJson || isAgentMode()) {
    console.log(JSON.stringify({ error: { code: "node_not_found", message: msg, hint } }, null, 2));
  } else {
    console.error(`\n  ${msg}`);
    if (hint) console.error(`  Hint: ${hint}`);
    console.error("");
  }
  process.exit(1);
}

function readFromCache(
  targetStr: string,
  depth: number,
  useJson: boolean,
  includePath?: boolean
): void {
  let nodeId: string | null = null;

  if (targetStr.startsWith("@") && targetStr.includes("/")) {
    const resolved = resolvePathOrId(targetStr);
    if (!resolved) {
      const msg = `No node found matching path "${targetStr}"`;
      if (isAgentMode()) {
        console.log(JSON.stringify({ error: { code: "node_not_found", message: msg, hint: "Try `wf node:read --live` or `wf cache:sync`" } }, null, 2));
      } else {
        console.error(`\n  ${msg}\n`);
      }
      process.exit(1);
    }
    nodeId = resolved.node.id;
  } else if (isDirectId(targetStr)) {
    nodeId = targetStr;
  } else {
    const resolved = resolveTarget(targetStr);
    const uuid = resolveSavedTargetNodeId(resolved.id);
    if (uuid) {
      nodeId = uuid;
    } else {
      const byId = getNodeById(resolved.id);
      if (byId) {
        nodeId = byId.id;
      } else {
        const children = getChildren(null);
        const match = children.find(
          (c) => cleanHtml(c.name).toLowerCase().includes(resolved.label.toLowerCase())
        );
        nodeId = match?.id ?? null;
      }
    }
  }

  if (!nodeId) {
    const msg = `Target "${targetStr}" not found in cache`;
    if (isAgentMode()) {
      console.log(JSON.stringify({ error: { code: "node_not_found", message: msg, hint: "Try `wf node:read --live` or `wf cache:sync`" } }, null, 2));
    } else {
      console.error(`\n  ${msg}. Try ${chalk.cyan("wf node:read --live")} or ${chalk.cyan("wf cache:sync")}.\n`);
    }
    process.exit(1);
  }

  const rootNode = getNodeById(nodeId);
  if (!rootNode) {
    const msg = `Target "${targetStr}" is not available in the current account cache`;
    if (useJson || isAgentMode()) {
      console.log(JSON.stringify({ error: { code: "node_not_found", message: msg, hint: "Run `wf cache:sync` or use `wf node:read --live`." } }, null, 2));
    } else {
      console.error(`\n  ${msg}. Try ${chalk.cyan("wf cache:sync")} or ${chalk.cyan("wf node:read --live")}.\n`);
    }
    process.exit(1);
    return;
  }

  nodeId = rootNode.id;

  recordAccess({
    id: rootNode.id,
    name: cleanHtml(rootNode.name),
    path: rootNode.parent_id ? buildBreadcrumb(rootNode.parent_id).join(" > ") : "(root)",
  });

  const flatNode = cachedNodeToFlat(rootNode, depth);
  const cacheAge = getCacheAgeSeconds();
  const stale = isCacheStale();

  if (useJson) {
    const config = loadConfig();
    const meta: Record<string, unknown> = {
      command: "node:read",
      target: targetStr,
      resolved_id: nodeId,
      timestamp: new Date().toISOString(),
      account: config.activeAccount,
      source: "cache",
      cache_age_seconds: cacheAge,
      cache_stale: stale,
      wf_version: "3.1.1",
    };

    const output: Record<string, unknown> = {
      meta,
      node: { id: flatNode.id, name: flatNode.name, note: flatNode.note, type: flatNode.type, completed: flatNode.completed, hasMore: false, children: [] },
      children: flatNode.children,
    };

    if (includePath) {
      const breadcrumb = buildBreadcrumb(nodeId);
      (output as Record<string, unknown>).path = breadcrumb.join(" > ");
    }

    console.log(formatJson(output));
  } else {
    if (stale && !isAgentMode()) {
      const age = cacheAge ? formatAge(cacheAge) : "unknown";
      console.log(`  ${chalk.yellow("⚠")} Cache is ${age} old. Run ${chalk.cyan("wf cache:sync")} to refresh.`);
    }

    const breadcrumb = buildBreadcrumb(nodeId);
    if (breadcrumb.length > 1) {
      console.log(`\n  ${chalk.dim(breadcrumb.slice(0, -1).join(" > "))}`);
    }
    console.log("");
    console.log(formatOutline(flatNode, depth));
    console.log("");
  }
}

function cachedNodeToFlat(node: CachedNode, maxDepth: number, currentDepth = 0): FlatNode {
  const children = currentDepth < maxDepth
    ? getChildren(node.id).map((c) => cachedNodeToFlat(c, maxDepth, currentDepth + 1))
    : [];

  const hasMore = currentDepth >= maxDepth && getChildren(node.id).length > 0;

  return {
    id: node.id,
    name: cleanHtml(node.name),
    note: node.note ? cleanHtml(node.note) : null,
    type: layoutModeToType(node.line_type),
    completed: node.completed === 1,
    hasMore,
    children,
  };
}

function layoutModeToType(mode: string | null): FlatNode["type"] {
  switch (mode) {
    case "todo": return "todo";
    case "h1": return "h1";
    case "h2": return "h2";
    case "h3": return "h3";
    case "code-block": case "code": return "code-block";
    case "quote-block": case "quote": return "quote-block";
    case "table": return "table";
    case "p": return "p";
    default: return "bullet";
  }
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
