import { Database } from "bun:sqlite";
import { getDbPath, loadConfig } from "./config.ts";
import { cleanHtml } from "./nodes.ts";

let _db: Database | null = null;

export function getCacheDb(): Database {
  if (!_db) {
    _db = new Database(getDbPath(), { create: true });
    _db.exec("PRAGMA busy_timeout = 5000");
    _db.exec("PRAGMA journal_mode = WAL");
    initCacheSchema(_db);
  }
  return _db;
}

export function resetCacheDb(): void {
  if (_db) {
    _db.close(false);
    _db = null;
  }
}

function getActiveAccountName(): string {
  return loadConfig().activeAccount || "default";
}

function getScopedMetaKey(key: string, account = getActiveAccountName()): string {
  return `account:${account}:${key}`;
}

function getScopedMeta(key: string, account = getActiveAccountName()): string | null {
  return getMeta(getScopedMetaKey(key, account));
}

function setScopedMeta(key: string, value: string, account = getActiveAccountName()): void {
  setMeta(getScopedMetaKey(key, account), value);
}

function deleteMeta(key: string): void {
  const db = getCacheDb();
  db.run("DELETE FROM cache_meta WHERE key = ?", [key]);
}

function getCacheAccount(): string | null {
  return getMeta("cache_account");
}

function isCacheCurrentAccount(): boolean {
  return getCacheAccount() === getActiveAccountName();
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

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_trigram USING fts5(
        name,
        note,
        content=nodes,
        content_rowid=rowid,
        tokenize='trigram'
      );
    `);
  } catch {
    // Older SQLite builds may not have the trigram tokenizer available.
  }
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
  if (!isCacheCurrentAccount()) return null;
  const val = getScopedMeta("last_synced_at");
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
  if (!isCacheCurrentAccount()) return 0;

  const cachedCount = getScopedMeta("node_count");
  if (cachedCount !== null) return Number(cachedCount);

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
  if (!isCacheCurrentAccount()) return null;

  const db = getCacheDb();
  const row = db.query("SELECT * FROM nodes WHERE id = ?").get(id) as CachedNode | null;
  if (row) return row;

  // WorkFlowy APIs may return full UUID-like IDs whose last segment is the
  // 12-hex tag stored in older/local cache rows.
  const lastSegment = id.includes("-") ? id.split("-").pop() : null;
  if (lastSegment && /^[0-9a-f]{8,12}$/i.test(lastSegment)) {
    const tagMatches = db.query("SELECT * FROM nodes WHERE id = ? OR id LIKE ? LIMIT 2")
      .all(lastSegment, `%-${lastSegment}`) as CachedNode[];
    if (tagMatches.length === 1) return tagMatches[0] ?? null;
  }

  // 12-hex tags from the LLM doc API are the last segment of v1 UUIDs
  if (/^[0-9a-f]{8,12}$/i.test(id)) {
    const tagMatches = db.query("SELECT * FROM nodes WHERE id = ? OR id LIKE ? LIMIT 2")
      .all(id, `%-${id}`) as CachedNode[];
    if (tagMatches.length === 1) return tagMatches[0] ?? null;
  }

  // Short UUID prefixes from CLI output should also resolve consistently.
  if (/^[0-9a-f]{8,}$/i.test(id)) {
    const prefixMatches = db.query("SELECT * FROM nodes WHERE LOWER(id) LIKE LOWER(?) LIMIT 2")
      .all(`${id}%`) as CachedNode[];
    if (prefixMatches.length === 1) return prefixMatches[0] ?? null;
  }

  return null;
}

// --- Target → UUID mapping ---
// System targets ("inbox", "today") are virtual keys the API understands,
// but the cache stores full UUIDs. After sync, we resolve the mapping
// via readDoc hex tags and store it in cache_meta.

export function getTargetUuid(targetKey: string): string | null {
  return getScopedMeta(`target:${targetKey}`);
}

export function setTargetUuid(targetKey: string, uuid: string): void {
  setScopedMeta(`target:${targetKey}`, uuid);
}

export function clearTargetUuid(targetKey: string): void {
  deleteMeta(getScopedMetaKey(`target:${targetKey}`));
}

// --- Dirty flags (post-write invalidation) ---
// After a write, mark the target dirty. Next cache read for that
// target automatically falls back to live API.

export function markTargetDirty(targetKey: string): void {
  setScopedMeta(`dirty:${targetKey}`, String(Date.now()));
}

export function isTargetDirty(targetKey: string): boolean {
  return getScopedMeta(`dirty:${targetKey}`) !== null;
}

export function clearTargetDirty(targetKey: string): void {
  deleteMeta(getScopedMetaKey(`dirty:${targetKey}`));
}

export function clearAllDirtyFlags(): void {
  const db = getCacheDb();
  db.run("DELETE FROM cache_meta WHERE key LIKE ?", [`${getScopedMetaKey("dirty:")}%`]);
}

export function getChildren(parentId: string | null): CachedNode[] {
  if (!isCacheCurrentAccount()) return [];

  const db = getCacheDb();
  if (parentId === null) {
    return db.query("SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY priority, name").all() as CachedNode[];
  }
  return db.query("SELECT * FROM nodes WHERE parent_id = ? ORDER BY priority, name").all(parentId) as CachedNode[];
}

export function getSubtreeIds(rootId: string): Set<string> {
  if (!isCacheCurrentAccount()) return new Set();

  const db = getCacheDb();
  const ids = new Set<string>();
  const normalizedRoot = getNodeById(rootId)?.id ?? rootId;
  const queue = [normalizedRoot];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (ids.has(current)) continue;

    ids.add(current);
    const children = db.query("SELECT id FROM nodes WHERE parent_id = ?").all(current) as Array<{ id: string }>;
    for (const child of children) {
      queue.push(child.id);
    }
  }

  return ids;
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

function buildIdScopeClause(scopeIds?: Set<string>): { clause: string; params: string[] } {
  if (!scopeIds) return { clause: "", params: [] };
  if (scopeIds.size === 0) return { clause: " AND 0", params: [] };

  const ids = [...scopeIds];
  return {
    clause: ` AND n.id IN (${ids.map(() => "?").join(", ")})`,
    params: ids,
  };
}

export function searchNodes(query: string, limit = 20, scopeIds?: Set<string>): SearchResult[] {
  if (!isCacheCurrentAccount()) return [];

  const db = getCacheDb();

  const ftsQuery = query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" AND ");

  if (!ftsQuery) return [];

  const scope = buildIdScopeClause(scopeIds);
  const rows = db.query(`
    SELECT n.*, nodes_fts.rank
    FROM nodes_fts
    JOIN nodes n ON n.rowid = nodes_fts.rowid
    WHERE nodes_fts MATCH ?${scope.clause}
    ORDER BY nodes_fts.rank
    LIMIT ?
  `).all(ftsQuery, ...scope.params, limit) as Array<CachedNode & { rank: number }>;

  return rows.map((row) => ({
    ...row,
    parent_path: row.parent_id ? buildBreadcrumbDisplay(row.parent_id) : "(root)",
  }));
}

export function searchNodesByTrigram(matchQuery: string, limit = 20, scopeIds?: Set<string>): SearchResult[] {
  if (!matchQuery.trim()) return [];
  if (!isCacheCurrentAccount()) return [];

  const db = getCacheDb();

  try {
    const scope = buildIdScopeClause(scopeIds);
    const rows = db.query(`
      SELECT n.*, 0 as rank
      FROM nodes_trigram
      JOIN nodes n ON n.rowid = nodes_trigram.rowid
      WHERE nodes_trigram MATCH ?${scope.clause}
      LIMIT ?
    `).all(matchQuery, ...scope.params, limit) as Array<CachedNode & { rank: number }>;

    return rows.map((row) => ({
      ...row,
      parent_path: row.parent_id ? buildBreadcrumbDisplay(row.parent_id) : "(root)",
    }));
  } catch {
    return [];
  }
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
  const account = getActiveAccountName();

  const txn = db.transaction(() => {
    db.run("DELETE FROM nodes");
    db.run("DELETE FROM nodes_fts");
    try {
      db.run("DELETE FROM nodes_trigram");
    } catch {
      // Trigram index is optional.
    }

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
    try {
      db.run("INSERT INTO nodes_trigram(nodes_trigram) VALUES('rebuild')");
    } catch {
      // Trigram index is optional.
    }

    setMeta("cache_account", account);
    setScopedMeta("last_synced_at", String(syncedAt), account);
    setScopedMeta("node_count", String(nodes.length), account);
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
    try {
      db.run("INSERT INTO nodes_trigram(nodes_trigram) VALUES('rebuild')");
    } catch {
      // Trigram index is optional.
    }
  });

  txn();
}
