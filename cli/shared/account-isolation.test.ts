import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.WORKFLOWY_CONFIG_DIR;
const testHome = mkdtempSync(join(tmpdir(), "workflowy-cli-account-"));
const testConfigDir = join(testHome, ".workflowy");

let cacheModule: typeof import("./cache.ts");
let configModule: typeof import("./config.ts");
let dbModule: typeof import("./db.ts");
let historyModule: typeof import("./history.ts");

function cleanupWorkspace(): void {
  cacheModule.resetCacheDb();
  dbModule.resetDb();

  const workflowyDir = join(testHome, ".workflowy");
  if (existsSync(workflowyDir)) {
    rmSync(workflowyDir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  process.env.HOME = testHome;
  process.env.WORKFLOWY_CONFIG_DIR = testConfigDir;
  configModule = await import("./config.ts");
  cacheModule = await import("./cache.ts");
  dbModule = await import("./db.ts");
  historyModule = await import("./history.ts");
});

afterEach(() => {
  cleanupWorkspace();
});

afterAll(() => {
  cleanupWorkspace();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalConfigDir === undefined) {
    delete process.env.WORKFLOWY_CONFIG_DIR;
  } else {
    process.env.WORKFLOWY_CONFIG_DIR = originalConfigDir;
  }

  rmSync(testHome, { recursive: true, force: true });
});

test("cache metadata and history stay isolated per account", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
      test: { name: "test", token: "token-test" },
    },
  });

  cacheModule.replaceAllNodes([
    {
      id: "node-default",
      name: "Default account root",
      note: null,
      parent_id: null,
      modifiedAt: 100,
    },
  ]);
  cacheModule.setTargetUuid("inbox", "node-default");
  cacheModule.markTargetDirty("inbox");
  historyModule.recordAccess({
    id: "node-default",
    name: "Default account root",
    path: "(root)",
  });

  expect(cacheModule.getCacheNodeCount()).toBe(1);
  expect(cacheModule.getTargetUuid("inbox")).toBe("node-default");
  expect(cacheModule.isTargetDirty("inbox")).toBe(true);
  expect(historyModule.getAccessHistory()).toHaveLength(1);
  expect(cacheModule.getLastSyncedAt()).not.toBeNull();

  configModule.saveConfig({
    activeAccount: "test",
    accounts: {
      default: { name: "default", token: "token-default" },
      test: { name: "test", token: "token-test" },
    },
  });

  expect(cacheModule.getCacheNodeCount()).toBe(0);
  expect(cacheModule.getTargetUuid("inbox")).toBeNull();
  expect(cacheModule.isTargetDirty("inbox")).toBe(false);
  expect(historyModule.getAccessHistory()).toEqual([]);
  expect(cacheModule.getLastSyncedAt()).toBeNull();

  historyModule.recordAccess({
    id: "node-test",
    name: "Test account root",
    path: "(root)",
  });
  expect(historyModule.getAccessHistory().map((entry) => entry.id)).toEqual(["node-test"]);

  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
      test: { name: "test", token: "token-test" },
    },
  });

  expect(cacheModule.getCacheNodeCount()).toBe(1);
  expect(cacheModule.getTargetUuid("inbox")).toBe("node-default");
  expect(cacheModule.isTargetDirty("inbox")).toBe(true);
  expect(historyModule.getAccessHistory().map((entry) => entry.id)).toEqual(["node-default"]);
});

test("bookmark cache migrates legacy schema and allows duplicate ids across accounts", () => {
  cleanupWorkspace();

  const legacyDb = new Database(configModule.getDbPath(), { create: true });
  legacyDb.exec(`
    DROP TABLE IF EXISTS bookmarks;
    CREATE TABLE bookmarks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      node_id TEXT NOT NULL,
      account TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  legacyDb.run(
    "INSERT INTO bookmarks (id, name, node_id, account, updated_at) VALUES (?, ?, ?, ?, unixepoch())",
    ["inbox", "inbox", "node-default", "default"]
  );
  legacyDb.close(false);

  expect(dbModule.getCachedBookmarks("default")).toEqual([
    { id: "inbox", name: "inbox", nodeId: "node-default" },
  ]);

  dbModule.cacheBookmarks("test", [
    { id: "inbox", name: "inbox", nodeId: "node-test" },
  ]);

  expect(dbModule.getCachedBookmarks("default")).toEqual([
    { id: "inbox", name: "inbox", nodeId: "node-default" },
  ]);
  expect(dbModule.getCachedBookmarks("test")).toEqual([
    { id: "inbox", name: "inbox", nodeId: "node-test" },
  ]);
});
