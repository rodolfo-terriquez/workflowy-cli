import { loadConfig } from "./config.ts";
import { getChildren, getNodeById, type CachedNode } from "./cache.ts";
import { resolveCacheTargetReference } from "./path.ts";
import { cleanHtml } from "./nodes.ts";

export function getConfiguredMcpInstructionsTarget(): string | null {
  const configured = loadConfig().mcp?.instructionsNode?.trim();
  return configured ? configured : null;
}

export function resolveConfiguredMcpInstructionsNode(): CachedNode | null {
  const configured = getConfiguredMcpInstructionsTarget();
  if (!configured) return null;

  const resolved = resolveCacheTargetReference(configured);
  if (!resolved) return null;

  return getNodeById(resolved.id);
}

export function getConfiguredMcpInstructions(maxDepth = 4): string | null {
  const node = resolveConfiguredMcpInstructionsNode();
  if (!node) return null;

  const lines = flattenInstructionsNode(node, 0, maxDepth);
  const instructions = lines.join("\n").trim();
  return instructions.length > 0 ? instructions : null;
}

function flattenInstructionsNode(node: CachedNode, depth: number, maxDepth: number): string[] {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  const name = cleanHtml(node.name);
  const note = node.note ? cleanHtml(node.note) : null;

  if (name) {
    lines.push(depth === 0 ? name : `${indent}- ${name}`);
  }

  if (note) {
    lines.push(`${indent}${depth === 0 ? "" : "  "}${note}`);
  }

  if (depth >= maxDepth) {
    return lines;
  }

  for (const child of getChildren(node.id)) {
    lines.push(...flattenInstructionsNode(child, depth + 1, maxDepth));
  }

  return lines;
}
