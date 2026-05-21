import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getDbPath } from "./config.ts";

let _db: Database | null = null;
const TARGET_CACHE_TTL_SECONDS = 60 * 60;
const attemptedLegacyBookmarkImports = new Set<string>();

export interface CachedTarget {
  key: string;
  label: string;
  nodeId: string | null;
  type: "shortcut" | "system";
}

export interface StoredBookmark {
  name: string;
  nodeId: string;
  context: string | null;
  createdAt: string;
  updatedAt: number;
}

export function getDb(): Database {
  if (!_db) {
    _db = new Database(getDbPath(), { create: true });
    _db.exec("PRAGMA busy_timeout = 5000");
    _db.exec("PRAGMA journal_mode = WAL");
    initSchema(_db);
  }
  return _db;
}

export function resetDb(): void {
  if (_db) {
    _db.close(false);
    _db = null;
  }
  attemptedLegacyBookmarkImports.clear();
}

function initSchema(db: Database): void {
  migrateLegacyTargetCacheSchema(db);
  migrateLegacyLocalBookmarksSchema(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS target_cache (
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      node_id TEXT,
      type TEXT NOT NULL,
      account TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (account, key)
    );
    CREATE INDEX IF NOT EXISTS idx_target_cache_account_updated_at ON target_cache(account, updated_at);

    CREATE TABLE IF NOT EXISTS bookmarks (
      name TEXT NOT NULL,
      node_id TEXT NOT NULL,
      context TEXT,
      account TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (account, name)
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_account_updated_at ON bookmarks(account, updated_at);

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      instructions TEXT NOT NULL,
      operations TEXT NOT NULL,
      preview TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

function migrateLegacyTargetCacheSchema(db: Database): void {
  const columns = db.query("PRAGMA table_info(bookmarks)").all() as Array<{ name: string; pk: number }>;
  if (columns.length === 0) return;

  if (!columns.some((column) => column.name === "id")) return;

  const txn = db.transaction(() => {
    db.exec("ALTER TABLE bookmarks RENAME TO bookmarks_legacy");
    db.exec(`
      CREATE TABLE IF NOT EXISTS target_cache (
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        node_id TEXT,
        type TEXT NOT NULL,
        account TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account, key)
      );
      CREATE INDEX IF NOT EXISTS idx_target_cache_account_updated_at ON target_cache(account, updated_at);

      CREATE TABLE bookmarks (
        name TEXT NOT NULL,
        node_id TEXT NOT NULL,
        context TEXT,
        account TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account, name)
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_account_updated_at ON bookmarks(account, updated_at);
    `);
    db.exec(`
      INSERT OR REPLACE INTO target_cache (key, label, node_id, type, account, updated_at)
      SELECT id, name, node_id, 'shortcut', account, updated_at
      FROM bookmarks_legacy
    `);
    db.exec("DROP TABLE bookmarks_legacy");
  });

  txn();
}

function migrateLegacyLocalBookmarksSchema(db: Database): void {
  const columns = db.query("PRAGMA table_info(bookmarks)").all() as Array<{ name: string }>;
  if (columns.length === 0 || columns.some((column) => column.name === "context")) return;

  const hasAccount = columns.some((column) => column.name === "account");
  const hasCreatedAt = columns.some((column) => column.name === "created_at");
  const hasUpdatedAt = columns.some((column) => column.name === "updated_at");

  const legacySelect = [
    "name",
    "node_id",
    hasAccount ? "account" : "'default' AS account",
    hasCreatedAt ? "created_at" : "CURRENT_TIMESTAMP AS created_at",
    hasUpdatedAt ? "updated_at" : "unixepoch() AS updated_at",
  ].join(", ");

  const txn = db.transaction(() => {
    db.exec("ALTER TABLE bookmarks RENAME TO bookmarks_legacy_local");
    db.exec(`
      CREATE TABLE bookmarks (
        name TEXT NOT NULL,
        node_id TEXT NOT NULL,
        context TEXT,
        account TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account, name)
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_account_updated_at ON bookmarks(account, updated_at);
    `);
    db.exec(`
      INSERT OR REPLACE INTO bookmarks (name, node_id, context, account, created_at, updated_at)
      SELECT name, node_id, NULL, account, created_at, updated_at
      FROM (SELECT ${legacySelect} FROM bookmarks_legacy_local)
    `);
    db.exec("DROP TABLE bookmarks_legacy_local");
  });

  txn();
}

function ensureLegacyBookmarksImported(account: string): void {
  if (attemptedLegacyBookmarkImports.has(account)) return;
  attemptedLegacyBookmarkImports.add(account);

  const legacyBookmarksPath = getLegacyBookmarksPath();
  const db = getDb();
  const existing = db
    .query("SELECT 1 FROM bookmarks WHERE account = ? LIMIT 1")
    .get(account) as { 1: number } | null;
  if (existing || !existsSync(legacyBookmarksPath)) {
    return;
  }

  let legacyDb: Database | null = null;

  try {
    legacyDb = new Database(legacyBookmarksPath, { create: false, readonly: true });
    const hasLegacyTable = legacyDb
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookmarks'")
      .get() as { name: string } | null;

    if (!hasLegacyTable) return;

    const rows = legacyDb.query(
      "SELECT name, node_id, context, created_at FROM bookmarks ORDER BY created_at"
    ).all() as Array<{ name: string; node_id: string; context: string | null; created_at: string | null }>;

    if (rows.length === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const txn = db.transaction(() => {
      const insert = db.query(`
        INSERT OR REPLACE INTO bookmarks (name, node_id, context, account, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const row of rows) {
        insert.run(
          normalizeBookmarkName(row.name),
          row.node_id,
          row.context ?? null,
          account,
          row.created_at ?? new Date(now * 1000).toISOString(),
          now,
        );
      }
    });

    txn();
  } catch {
    // Ignore unreadable legacy bookmark DBs.
  } finally {
    legacyDb?.close(false);
  }
}

function getLegacyBookmarksPath(): string {
  return join(
    process.env.HOME || homedir(),
    "Library",
    "Application Support",
    "com.workflowy.local-mcp",
    "bookmarks.db",
  );
}

export function normalizeBookmarkName(name: string): string {
  return name
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function getCachedTargets(account: string): CachedTarget[] | null {
  const db = getDb();
  const row = db
    .query("SELECT updated_at FROM target_cache WHERE account = ? LIMIT 1")
    .get(account) as { updated_at: number } | null;

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (now - row.updated_at > TARGET_CACHE_TTL_SECONDS) return null;

  const rows = db
    .query("SELECT key, label, node_id, type FROM target_cache WHERE account = ? ORDER BY key")
    .all(account) as Array<{ key: string; label: string; node_id: string | null; type: "shortcut" | "system" }>;

  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    nodeId: row.node_id,
    type: row.type,
  }));
}

export function getCachedTargetNodeId(account: string, key: string): string | null {
  const db = getDb();
  const row = db
    .query("SELECT node_id FROM target_cache WHERE account = ? AND key = ?")
    .get(account, key) as { node_id: string | null } | null;

  return row?.node_id ?? null;
}

export function cacheTargets(
  account: string,
  targets: CachedTarget[]
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    db.run("DELETE FROM target_cache WHERE account = ?", [account]);
    const insert = db.query(
      "INSERT INTO target_cache (key, label, node_id, type, account, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const target of targets) {
      insert.run(target.key, target.label, target.nodeId, target.type, account, now);
    }
  });

  txn();
}

export function listBookmarks(account: string): StoredBookmark[] {
  ensureLegacyBookmarksImported(account);

  const db = getDb();
  const rows = db.query(`
    SELECT name, node_id, context, created_at, updated_at
    FROM bookmarks
    WHERE account = ?
    ORDER BY name
  `).all(account) as Array<{
    name: string;
    node_id: string;
    context: string | null;
    created_at: string;
    updated_at: number;
  }>;

  return rows.map((row) => ({
    name: row.name,
    nodeId: row.node_id,
    context: row.context ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getBookmark(account: string, name: string): StoredBookmark | null {
  ensureLegacyBookmarksImported(account);

  const db = getDb();
  const row = db.query(`
    SELECT name, node_id, context, created_at, updated_at
    FROM bookmarks
    WHERE account = ? AND name = ?
  `).get(account, normalizeBookmarkName(name)) as {
    name: string;
    node_id: string;
    context: string | null;
    created_at: string;
    updated_at: number;
  } | null;

  if (!row) return null;

  return {
    name: row.name,
    nodeId: row.node_id,
    context: row.context ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveBookmark(
  account: string,
  bookmark: { name: string; nodeId: string; context?: string | null }
): StoredBookmark {
  const normalizedName = normalizeBookmarkName(bookmark.name);
  const createdAt = new Date().toISOString();
  const updatedAt = Math.floor(Date.now() / 1000);
  const db = getDb();

  db.run(`
    INSERT INTO bookmarks (name, node_id, context, account, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account, name) DO UPDATE SET
      node_id = excluded.node_id,
      context = excluded.context,
      updated_at = excluded.updated_at
  `, [normalizedName, bookmark.nodeId, bookmark.context ?? null, account, createdAt, updatedAt]);

  return getBookmark(account, normalizedName)!;
}

export interface StoredProposal {
  id: string;
  account: string;
  instructions: string;
  operations: string;
  preview: string;
  status: string;
  created_at: number;
}

export function saveProposal(proposal: {
  id: string;
  account: string;
  instructions: string;
  operations: LlmDocOperation[];
  preview: string;
}): void {
  const db = getDb();
  db.run(
    "INSERT OR REPLACE INTO proposals (id, account, instructions, operations, preview, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    [
      proposal.id,
      proposal.account,
      proposal.instructions,
      JSON.stringify(proposal.operations),
      proposal.preview,
    ]
  );
}

export function getPendingProposal(
  account: string
): StoredProposal | null {
  const db = getDb();
  return (
    (db
      .query(
        "SELECT * FROM proposals WHERE account = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
      )
      .get(account) as StoredProposal | null) ?? null
  );
}

export function updateProposalStatus(id: string, status: string): void {
  const db = getDb();
  db.run("UPDATE proposals SET status = ? WHERE id = ?", [status, id]);
}

interface LlmDocOperation {
  op: string;
  [key: string]: unknown;
}
