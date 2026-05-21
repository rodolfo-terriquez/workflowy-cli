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

test("target cache migrates legacy schema and allows duplicate ids across accounts", () => {
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

  expect(dbModule.getCachedTargets("default")).toEqual([
    { key: "inbox", label: "inbox", nodeId: "node-default", type: "shortcut" },
  ]);

  dbModule.cacheTargets("test", [
    { key: "inbox", label: "inbox", nodeId: "node-test", type: "shortcut" },
  ]);

  expect(dbModule.getCachedTargets("default")).toEqual([
    { key: "inbox", label: "inbox", nodeId: "node-default", type: "shortcut" },
  ]);
  expect(dbModule.getCachedTargets("test")).toEqual([
    { key: "inbox", label: "inbox", nodeId: "node-test", type: "shortcut" },
  ]);
});

test("local bookmarks stay isolated per account", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
      test: { name: "test", token: "token-test" },
    },
  });

  dbModule.saveBookmark("default", {
    name: "home",
    nodeId: "node-default",
    context: "Default account bookmark",
  });

  expect(dbModule.listBookmarks("default").map((bookmark) => bookmark.name)).toEqual(["home"]);
  expect(dbModule.listBookmarks("test")).toEqual([]);

  configModule.saveConfig({
    activeAccount: "test",
    accounts: {
      default: { name: "default", token: "token-default" },
      test: { name: "test", token: "token-test" },
    },
  });

  dbModule.saveBookmark("test", {
    name: "home",
    nodeId: "node-test",
    context: "Test account bookmark",
  });

  expect(dbModule.listBookmarks("default").map((bookmark) => bookmark.nodeId)).toEqual(["node-default"]);
  expect(dbModule.listBookmarks("test").map((bookmark) => bookmark.nodeId)).toEqual(["node-test"]);

  expect(dbModule.getBookmark("default", "home")?.context).toBe("Default account bookmark");
  expect(dbModule.getBookmark("test", "home")?.context).toBe("Test account bookmark");
});

test("local bookmark schema migrates to include context fields", () => {
  cleanupWorkspace();

  const legacyDb = new Database(configModule.getDbPath(), { create: true });
  legacyDb.exec(`
    DROP TABLE IF EXISTS bookmarks;
    CREATE TABLE bookmarks (
      name TEXT NOT NULL,
      node_id TEXT NOT NULL,
      account TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (account, name)
    );
  `);
  legacyDb.run(
    "INSERT INTO bookmarks (name, node_id, account, updated_at) VALUES (?, ?, ?, unixepoch())",
    ["home", "node-default", "default"]
  );
  legacyDb.close(false);

  expect(dbModule.listBookmarks("default")).toEqual([
    {
      name: "home",
      nodeId: "node-default",
      context: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(Number),
    },
  ]);
});
