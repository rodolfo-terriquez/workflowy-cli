import type { WorkflowyAPI, WFTarget } from "./shared/api.ts";
import { getActiveAccountName } from "./shared/config.ts";
import { getTargetUuid } from "./shared/cache.ts";
import {
  cacheTargets,
  getBookmark,
  getCachedTargetNodeId,
  getCachedTargets,
  listBookmarks,
  normalizeBookmarkName,
} from "./shared/db.ts";
import { buildBreadcrumb, getNodeById } from "./shared/cache.ts";

export interface ResolvedTarget {
  id: string;
  label: string;
  source: "builtin" | "shortcut" | "bookmark" | "direct";
}

const SYSTEM_TARGETS: Record<string, string> = {
  inbox: "Inbox",
  today: "Today",
  tomorrow: "Tomorrow",
  calendar: "Calendar",
  next_week: "Next Week",
};

export function normalizeTargetKey(targetStr: string): string {
  return normalizeBookmarkName(targetStr);
}

export function resolveTarget(targetStr: string): ResolvedTarget {
  if (!targetStr.startsWith("@")) {
    return { id: targetStr, label: targetStr, source: "direct" };
  }

  const name = normalizeTargetKey(targetStr);

  if (name in SYSTEM_TARGETS) {
    return {
      id: name,
      label: SYSTEM_TARGETS[name]!,
      source: "builtin",
    };
  }

  const account = getActiveAccountName();
  if (getBookmark(account, name)) {
    return {
      id: name,
      label: name,
      source: "bookmark",
    };
  }

  // User-defined shortcuts — the API accepts the shortcut key directly as a parent_id
  return {
    id: name,
    label: name,
    source: "shortcut",
  };
}

export function resolveSavedTargetNodeId(targetKey: string): string | null {
  const normalized = normalizeTargetKey(targetKey);
  const account = getActiveAccountName();

  const bookmark = getBookmark(account, normalized);
  if (bookmark) return bookmark.nodeId;

  const cachedTarget = getCachedTargetNodeId(account, normalized);
  if (cachedTarget) return cachedTarget;

  return getTargetUuid(normalized);
}

export async function listAllTargets(
  api: WorkflowyAPI
): Promise<WFTarget[]> {
  const account = getActiveAccountName();

  const cached = getCachedTargets(account);
  if (cached) {
    return mergeLocalBookmarks(
      cached.map((target) => ({
        key: target.key,
        type: target.type,
        name: target.label,
        nodeId: target.nodeId,
        path: target.nodeId ? buildTargetPath(target.nodeId) : null,
        kind: target.type === "system" ? "system" : "bookmark",
      })),
      account,
    );
  }

  const targets = await api.getTargets();

  cacheTargets(
    account,
    targets.map((t) => ({
      key: normalizeTargetKey(t.key),
      label: t.name ?? t.key,
      nodeId: null,
      type: t.type,
    }))
  );

  return mergeLocalBookmarks(targets, account);
}

function mergeLocalBookmarks(targets: WFTarget[], account: string): WFTarget[] {
  const merged = new Map<string, WFTarget>();

  for (const target of targets) {
    merged.set(normalizeTargetKey(target.key), {
      key: normalizeTargetKey(target.key),
      type: target.type,
      name: target.name,
      nodeId: target.nodeId ?? null,
      context: target.context ?? null,
      path: target.path ?? (target.nodeId ? buildTargetPath(target.nodeId) : null),
      kind: target.kind ?? (target.type === "system" ? "system" : "bookmark"),
    });
  }

  for (const bookmark of listBookmarks(account)) {
    const node = getNodeById(bookmark.nodeId);
    merged.set(bookmark.name, {
      key: bookmark.name,
      type: "shortcut",
      name: node?.name ?? bookmark.name,
      context: bookmark.context,
      nodeId: bookmark.nodeId,
      path: node ? buildBreadcrumb(bookmark.nodeId).join(" > ") : null,
      kind: "bookmark",
    });
  }

  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function buildTargetPath(nodeId: string): string | null {
  const path = buildBreadcrumb(nodeId);
  return path.length > 0 ? path.join(" > ") : null;
}
