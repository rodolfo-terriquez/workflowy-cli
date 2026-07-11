import { getActiveAccountName } from "./config.ts";
import { getMeta, setMeta } from "./cache.ts";

export interface HistoryEntry {
  id: string;
  name: string;
  path: string;
  accessed_at: string;
}

const MAX_ENTRIES = 100;

function getHistoryKey(): string {
  const account = getActiveAccountName();
  return `access_history:${account}`;
}

export function getAccessHistory(): HistoryEntry[] {
  const raw = getMeta(getHistoryKey());
  if (!raw) return [];
  try {
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

export function recordAccess(entry: Omit<HistoryEntry, "accessed_at">): void {
  const history = getAccessHistory();

  const filtered = history.filter((h) => h.id !== entry.id);

  filtered.unshift({
    ...entry,
    accessed_at: new Date().toISOString(),
  });

  if (filtered.length > MAX_ENTRIES) {
    filtered.length = MAX_ENTRIES;
  }

  setMeta(getHistoryKey(), JSON.stringify(filtered));
}
