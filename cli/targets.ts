import type { WorkflowyAPI, WFTarget } from "./shared/api.ts";
import { loadConfig } from "./shared/config.ts";
import { getCachedBookmarks, cacheBookmarks } from "./shared/db.ts";

export interface ResolvedTarget {
  id: string;
  label: string;
  source: "builtin" | "shortcut" | "direct";
}

const SYSTEM_TARGETS: Record<string, string> = {
  inbox: "Inbox",
  today: "Today",
  tomorrow: "Tomorrow",
  calendar: "Calendar",
  next_week: "Next Week",
};

export function resolveTarget(targetStr: string): ResolvedTarget {
  if (!targetStr.startsWith("@")) {
    return { id: targetStr, label: targetStr, source: "direct" };
  }

  const name = targetStr.slice(1).toLowerCase().replace(/-/g, "_");

  if (name in SYSTEM_TARGETS) {
    return {
      id: name,
      label: SYSTEM_TARGETS[name]!,
      source: "builtin",
    };
  }

  // User-defined shortcuts — the API accepts the shortcut key directly as a parent_id
  return {
    id: name,
    label: name,
    source: "shortcut",
  };
}

export async function listAllTargets(
  api: WorkflowyAPI
): Promise<WFTarget[]> {
  const config = loadConfig();
  const account = config.activeAccount;

  const cached = getCachedBookmarks(account);
  if (cached) {
    return cached.map((b) => ({
      key: b.name,
      type: "shortcut" as const,
      name: b.nodeId,
    }));
  }

  const targets = await api.getTargets();

  cacheBookmarks(
    account,
    targets.map((t) => ({
      id: t.key,
      name: t.key,
      nodeId: t.name ?? t.key,
    }))
  );

  return targets;
}
