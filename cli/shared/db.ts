import { Database } from "bun:sqlite";
import { getDbPath } from "./config.ts";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(getDbPath(), { create: true });
    _db.exec("PRAGMA journal_mode = WAL");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      node_id TEXT NOT NULL,
      account TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

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

export function getCachedBookmarks(
  account: string
): Array<{ id: string; name: string; nodeId: string }> | null {
  const db = getDb();
  const row = db
    .query("SELECT updated_at FROM bookmarks WHERE account = ? LIMIT 1")
    .get(account) as { updated_at: number } | null;

  if (!row) return null;

  const ONE_HOUR = 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (now - row.updated_at > ONE_HOUR) return null;

  const rows = db
    .query("SELECT id, name, node_id FROM bookmarks WHERE account = ?")
    .all(account) as Array<{ id: string; name: string; node_id: string }>;

  return rows.map((r) => ({ id: r.id, name: r.name, nodeId: r.node_id }));
}

export function cacheBookmarks(
  account: string,
  bookmarks: Array<{ id: string; name: string; nodeId: string }>
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    db.run("DELETE FROM bookmarks WHERE account = ?", [account]);
    const insert = db.query(
      "INSERT INTO bookmarks (id, name, node_id, account, updated_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const b of bookmarks) {
      insert.run(b.id, b.name, b.nodeId, account, now);
    }
  });

  txn();
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
