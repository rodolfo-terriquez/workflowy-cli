import { getCacheDb, getChildren, getNodeById, type CachedNode } from "./cache.ts";
import { cleanHtml } from "./nodes.ts";
import { resolveSavedTargetNodeId, resolveTarget } from "../targets.ts";

export interface ResolvedPath {
  node: CachedNode;
  breadcrumb: string[];
}

export interface ResolvedTargetReference {
  id: string;
  label: string;
  source: "path" | "builtin" | "shortcut" | "bookmark" | "direct";
}

const HEX_ID = /^[0-9a-f]{8,}(-[0-9a-f]{4,}){0,4}$/i;

export function isDirectId(input: string): boolean {
  return HEX_ID.test(input);
}

export function resolvePathOrId(input: string): ResolvedPath | null {
  if (isDirectId(input)) {
    const node = getNodeById(input);
    if (!node) return null;
    return { node, breadcrumb: [] };
  }

  if (input.startsWith("@") && input.includes("/")) {
    return resolvePathTraversal(input);
  }

  return null;
}

export function resolveTargetReference(input: string): ResolvedTargetReference | null {
  if (input.startsWith("@") && input.includes("/")) {
    const resolved = resolvePathTraversal(input);
    if (!resolved) return null;
    return {
      id: resolved.node.id,
      label: input,
      source: "path",
    };
  }

  const resolved = resolveTarget(input);
  const mappedUuid = resolveSavedTargetNodeId(resolved.id);

  if (mappedUuid) {
    return {
      id: mappedUuid,
      label: input.startsWith("@") ? input : resolved.label,
      source: resolved.source,
    };
  }

  if (resolved.source === "builtin" || resolved.source === "bookmark") {
    return null;
  }

  return {
    id: resolved.id,
    label: input.startsWith("@") ? input : resolved.label,
    source: resolved.source,
  };
}

export function resolveCacheTargetReference(input: string): ResolvedTargetReference | null {
  if (input.startsWith("@") && input.includes("/")) {
    const resolved = resolvePathTraversal(input);
    if (!resolved) return null;
    return {
      id: resolved.node.id,
      label: input,
      source: "path",
    };
  }

  if (isDirectId(input)) {
    const node = getNodeById(input);
    if (!node) return null;
    return {
      id: node.id,
      label: input,
      source: "direct",
    };
  }

  const resolved = resolveTarget(input);
  const uuid = resolveSavedTargetNodeId(resolved.id);
  if (uuid) {
    return {
      id: uuid,
      label: input.startsWith("@") ? input : resolved.label,
      source: resolved.source,
    };
  }

  const byId = getNodeById(resolved.id);
  if (byId) {
    return {
      id: byId.id,
      label: input.startsWith("@") ? input : resolved.label,
      source: resolved.source,
    };
  }

  return null;
}

function resolvePathTraversal(input: string): ResolvedPath | null {
  const parts = input.split("/");
  const targetPart = parts[0]!;
  const pathParts = parts.slice(1);

  const resolved = resolveTarget(targetPart);

  let current: CachedNode | null = null;

  // First try: use the stored target→UUID mapping from sync
  const uuid = resolveSavedTargetNodeId(resolved.id);
  if (uuid) {
    current = getNodeById(uuid);
  }

  // Fallback: look up by hex tag (the resolved.id might be a hex tag)
  if (!current) {
    current = getNodeById(resolved.id);
  }

  // Last resort: name-based search
  if (!current) {
    const candidates = findNodesByName(resolved.label);
    if (candidates.length > 0) current = candidates[0]!;
  }

  if (!current) return null;

  for (const segment of pathParts) {
    const segmentLower = segment.toLowerCase();
    const children = getChildren(current.id);
    const match = children.find(
      (c) => cleanHtml(c.name).toLowerCase() === segmentLower
    ) ?? children.find(
      (c) => cleanHtml(c.name).toLowerCase().includes(segmentLower)
    );

    if (!match) return null;
    current = match;
  }

  return { node: current, breadcrumb: [] };
}

export function findNodesByName(name: string): CachedNode[] {
  const db = getCacheDb();
  const nameLower = name.toLowerCase();

  const exact = db.query("SELECT * FROM nodes WHERE LOWER(name) = ?").all(nameLower) as CachedNode[];
  if (exact.length > 0) return exact;

  return db.query("SELECT * FROM nodes WHERE LOWER(name) LIKE ? LIMIT 10")
    .all(`%${nameLower}%`) as CachedNode[];
}

export function findByNameOrPath(input: string): CachedNode[] {
  if (isDirectId(input)) {
    const node = getNodeById(input);
    return node ? [node] : [];
  }

  // @target without path — use system target mapping
  if (input.startsWith("@") && !input.includes("/")) {
    const resolved = resolveTarget(input);
    const uuid = resolveSavedTargetNodeId(resolved.id);
    if (uuid) {
      const node = getNodeById(uuid);
      return node ? [node] : [];
    }
    return findNodesByName(resolved.label);
  }

  if (input.startsWith("@") && input.includes("/")) {
    const resolved = resolvePathTraversal(input);
    return resolved ? [resolved.node] : [];
  }

  return findNodesByName(input);
}
