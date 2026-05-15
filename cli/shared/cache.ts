import { Database } from "bun:sqlite";
import { getDbPath } from "./config.ts";
import { cleanHtml } from "./nodes.ts";

let _db: Database | null = null;

export function getCacheDb(): Database {
  if (!_db) {
    _db = new Database(getDbPath(), { create: true });
    _db.exec("PRAGMA journal_mode = WAL");
    initCacheSchema(_db);
  }
  return _db;
}

function initCacheSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id          TEXT PRIMARY KEY,
      parent_id   TEXT,
      name        TEXT NOT NULL DEFAULT '',
      note        TEXT,
      line_type   TEXT,
      completed   INTEGER NOT NULL DEFAULT 0,
      priority    REAL,
      created_at  INTEGER,
      modified_at INTEGER,
      synced_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      name,
      note,
      content=nodes,
      content_rowid=rowid
    );

    CREATE TABLE IF NOT EXISTS cache_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// --- Meta helpers ---

export function getMeta(key: string): string | null {
  const db = getCacheDb();
  const row = db.query("SELECT value FROM cache_meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  const db = getCacheDb();
  db.run("INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)", [key, value]);
}

export function getLastSyncedAt(): number | null {
  const val = getMeta("last_synced_at");
  return val ? Number(val) : null;
}

export function getCacheAgeSeconds(): number | null {
  const last = getLastSyncedAt();
  if (last === null) return null;
  return Math.floor((Date.now() - last) / 1000);
}

export function isCacheStale(thresholdSeconds = 300): boolean {
  const age = getCacheAgeSeconds();
  if (age === null) return true;
  return age > thresholdSeconds;
}

export function getCacheNodeCount(): number {
  const db = getCacheDb();
  const row = db.query("SELECT COUNT(*) as cnt FROM nodes").get() as { cnt: number };
  return row.cnt;
}

// --- Node read helpers ---

export interface CachedNode {
  id: string;
  parent_id: string | null;
  name: string;
  note: string | null;
  line_type: string | null;
  completed: number;
  priority: number | null;
  created_at: number | null;
  modified_at: number | null;
  synced_at: number;
}

export function getNodeById(id: string): CachedNode | null {
  const db = getCacheDb();
  const row = db.query("SELECT * FROM nodes WHERE id = ?").get(id) as CachedNode | null;
  if (row) return row;

  // 12-hex tags from the LLM doc API are the last segment of v1 UUIDs
  if (/^[0-9a-f]{8,12}$/i.test(id)) {
    return db.query("SELECT * FROM nodes WHERE id LIKE ? LIMIT 1")
      .get(`%-${id}`) as CachedNode | null;
  }

  return null;
}

// --- Target → UUID mapping ---
// System targets ("inbox", "today") are virtual keys the API understands,
// but the cache stores full UUIDs. After sync, we resolve the mapping
// via readDoc hex tags and store it in cache_meta.

export function getTargetUuid(targetKey: string): string | null {
  return getMeta(`target:${targetKey}`);
}

export function setTargetUuid(targetKey: string, uuid: string): void {
  setMeta(`target:${targetKey}`, uuid);
}

// --- Dirty flags (post-write invalidation) ---
// After a write, mark the target dirty. Next cache read for that
// target automatically falls back to live API.

export function markTargetDirty(targetKey: string): void {
  setMeta(`dirty:${targetKey}`, String(Date.now()));
}

export function isTargetDirty(targetKey: string): boolean {
  return getMeta(`dirty:${targetKey}`) !== null;
}

export function clearTargetDirty(targetKey: string): void {
  const db = getCacheDb();
  db.run("DELETE FROM cache_meta WHERE key = ?", [`dirty:${targetKey}`]);
}

export function clearAllDirtyFlags(): void {
  const db = getCacheDb();
  db.run("DELETE FROM cache_meta WHERE key LIKE 'dirty:%'");
}

export function getChildren(parentId: string | null): CachedNode[] {
  const db = getCacheDb();
  if (parentId === null) {
    return db.query("SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY priority, name").all() as CachedNode[];
  }
  return db.query("SELECT * FROM nodes WHERE parent_id = ? ORDER BY priority, name").all(parentId) as CachedNode[];
}

export function buildBreadcrumb(nodeId: string): string[] {
  const path: string[] = [];
  let currentId: string | null = nodeId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = getNodeById(currentId);
    if (!node) break;
    path.unshift(cleanHtml(node.name));
    currentId = node.parent_id;
  }

  return path;
}

export function buildBreadcrumbDisplay(nodeId: string): string {
  const parts = buildBreadcrumb(nodeId);
  if (parts.length === 0) return "(root)";
  if (parts.length > 4) {
    return `${parts[0]} > ... > ${parts[parts.length - 2]} > ${parts[parts.length - 1]}`;
  }
  return parts.join(" > ");
}

// --- FTS search ---

export interface SearchResult extends CachedNode {
  parent_path: string;
  rank: number;
}

export function searchNodes(query: string, limit = 20): SearchResult[] {
  const db = getCacheDb();

  const ftsQuery = query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" AND ");

  if (!ftsQuery) return [];

  const rows = db.query(`
    SELECT n.*, nodes_fts.rank
    FROM nodes_fts
    JOIN nodes n ON n.rowid = nodes_fts.rowid
    WHERE nodes_fts MATCH ?
    ORDER BY nodes_fts.rank
    LIMIT ?
  `).all(ftsQuery, limit) as Array<CachedNode & { rank: number }>;

  return rows.map((row) => ({
    ...row,
    parent_path: row.parent_id ? buildBreadcrumbDisplay(row.parent_id) : "(root)",
  }));
}

// --- Sync from API export ---

export function replaceAllNodes(
  nodes: Array<{
    id: string;
    parent_id?: string | null;
    name: string;
    note?: string | null;
    data?: { layoutMode?: string };
    completedAt?: number | null;
    priority?: number;
    createdAt?: number;
    modifiedAt?: number;
  }>
): { nodeCount: number; syncedAt: number } {
  const db = getCacheDb();
  const syncedAt = Date.now();

  const txn = db.transaction(() => {
    db.run("DELETE FROM nodes");
    db.run("DELETE FROM nodes_fts");

    const insert = db.query(`
      INSERT INTO nodes (id, parent_id, name, note, line_type, completed, priority, created_at, modified_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const n of nodes) {
      insert.run(
        n.id,
        n.parent_id ?? null,
        n.name ?? "",
        n.note ?? null,
        n.data?.layoutMode ?? null,
        n.completedAt ? 1 : 0,
        n.priority ?? 0,
        n.createdAt ?? null,
        n.modifiedAt ?? null,
        syncedAt
      );
    }

    db.run("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");

    setMeta("last_synced_at", String(syncedAt));
    setMeta("node_count", String(nodes.length));
  });

  txn();
  return { nodeCount: nodes.length, syncedAt };
}

// --- Post-write invalidation ---

export function invalidateNode(nodeId: string): void {
  const db = getCacheDb();
  db.run("DELETE FROM nodes WHERE id = ?", [nodeId]);
}

export function invalidateSubtree(parentId: string): void {
  const db = getCacheDb();
  const children = db.query("SELECT id FROM nodes WHERE parent_id = ?").all(parentId) as Array<{ id: string }>;
  for (const child of children) {
    invalidateSubtree(child.id);
  }
  db.run("DELETE FROM nodes WHERE id = ?", [parentId]);
}

export function upsertNodesFromApi(
  nodes: Array<{
    id: string;
    parent_id?: string | null;
    name: string;
    note?: string | null;
    data?: { layoutMode?: string };
    completedAt?: number | null;
    priority?: number;
    createdAt?: number;
    modifiedAt?: number;
  }>
): void {
  const db = getCacheDb();
  const syncedAt = Date.now();

  const txn = db.transaction(() => {
    const upsert = db.query(`
      INSERT OR REPLACE INTO nodes (id, parent_id, name, note, line_type, completed, priority, created_at, modified_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const n of nodes) {
      upsert.run(
        n.id,
        n.parent_id ?? null,
        n.name ?? "",
        n.note ?? null,
        n.data?.layoutMode ?? null,
        n.completedAt ? 1 : 0,
        n.priority ?? 0,
        n.createdAt ?? null,
        n.modifiedAt ?? null,
        syncedAt
      );
    }

    db.run("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  });

  txn();
}
