import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.WORKFLOWY_CONFIG_DIR;
const originalAccount = process.env.WORKFLOWY_ACCOUNT;
const originalApiEnvironment = process.env.WORKFLOWY_API_ENVIRONMENT;
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
  delete process.env.WORKFLOWY_ACCOUNT;
  delete process.env.WORKFLOWY_API_ENVIRONMENT;
  configModule = await import("./config.ts");
  cacheModule = await import("./cache.ts");
  dbModule = await import("./db.ts");
  historyModule = await import("./history.ts");
});

afterEach(() => {
  configModule.setAccountOverride(null);
  configModule.setApiEnvironmentOverride(null);
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

  if (originalAccount === undefined) {
    delete process.env.WORKFLOWY_ACCOUNT;
  } else {
    process.env.WORKFLOWY_ACCOUNT = originalAccount;
  }

  if (originalApiEnvironment === undefined) {
    delete process.env.WORKFLOWY_API_ENVIRONMENT;
  } else {
    process.env.WORKFLOWY_API_ENVIRONMENT = originalApiEnvironment;
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

  cacheModule.replaceAllNodes([
    {
      id: "node-test",
      name: "Test account root",
      note: null,
      parent_id: null,
      modifiedAt: 200,
    },
  ]);
  cacheModule.setTargetUuid("inbox", "node-test");
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

  configModule.saveConfig({
    activeAccount: "test",
    accounts: {
      default: { name: "default", token: "token-default" },
      test: { name: "test", token: "token-test" },
    },
  });

  expect(cacheModule.getCacheNodeCount()).toBe(1);
  expect(cacheModule.getNodeById("node-test")?.name).toBe("Test account root");
  expect(cacheModule.getTargetUuid("inbox")).toBe("node-test");
  expect(historyModule.getAccessHistory().map((entry) => entry.id)).toEqual(["node-test"]);
});

test("temporary account selection leaves the configured default unchanged", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
      work: { name: "work", token: "token-work" },
    },
  });

  cacheModule.replaceAllNodes([{ id: "default-root", name: "Default", parent_id: null }]);

  configModule.setAccountOverride("work");
  cacheModule.replaceAllNodes([{ id: "work-root", name: "Work", parent_id: null }]);
  expect(configModule.getActiveAccountName()).toBe("work");
  expect(cacheModule.getNodeById("work-root")?.name).toBe("Work");
  expect(configModule.loadConfig().activeAccount).toBe("default");

  configModule.setAccountOverride(null);
  expect(configModule.getActiveAccountName()).toBe("default");
  expect(cacheModule.getNodeById("default-root")?.name).toBe("Default");
  expect(cacheModule.getNodeById("work-root")).toBeNull();
  expect(configModule.getAccountCacheDbPath("default")).not.toBe(configModule.getAccountCacheDbPath("work"));
});

test("legacy single-account cache migrates into the matching account database", () => {
  cleanupWorkspace();
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
      work: { name: "work", token: "token-work" },
    },
  });

  const legacyDb = new Database(configModule.getDbPath(), { create: true });
  legacyDb.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL DEFAULT '',
      note TEXT,
      line_type TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      priority REAL,
      created_at INTEGER,
      modified_at INTEGER,
      synced_at INTEGER NOT NULL
    );
    CREATE TABLE cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  legacyDb.run(
    "INSERT INTO nodes (id, parent_id, name, synced_at) VALUES (?, ?, ?, ?)",
    ["legacy-root", null, "Legacy root", 123],
  );
  legacyDb.run("INSERT INTO cache_meta (key, value) VALUES (?, ?)", ["cache_account", "default"]);
  legacyDb.run("INSERT INTO cache_meta (key, value) VALUES (?, ?)", ["account:default:node_count", "1"]);
  legacyDb.run("INSERT INTO cache_meta (key, value) VALUES (?, ?)", ["account:default:last_synced_at", "123"]);
  legacyDb.close(false);

  expect(cacheModule.getCacheNodeCount()).toBe(1);
  expect(cacheModule.getNodeById("legacy-root")?.name).toBe("Legacy root");

  configModule.setAccountOverride("work");
  expect(cacheModule.getCacheNodeCount()).toBe(0);
  expect(cacheModule.getNodeById("legacy-root")).toBeNull();
});

test("config storage uses private directory and file permissions", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "secret-token" } },
  });

  if (process.platform !== "win32") {
    expect(statSync(testConfigDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(testConfigDir, "config.json")).mode & 0o777).toBe(0o600);
  }

  expect(configModule.loadConfig().accounts.default?.token).toBe("secret-token");
});

test("production and beta public API caches stay isolated for the same account", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "token-default" } },
  });
  cacheModule.replaceAllNodes([{ id: "production-root", name: "Production", parent_id: null }]);
  const productionPath = configModule.getAccountCacheDbPath("default");

  configModule.setApiEnvironmentOverride("beta");
  const betaPath = configModule.getAccountCacheDbPath("default");
  expect(betaPath).not.toBe(productionPath);
  expect(cacheModule.getCacheNodeCount()).toBe(0);

  cacheModule.replaceAllNodes([{ id: "beta-root", name: "Beta", parent_id: null }]);
  expect(cacheModule.getNodeById("beta-root")?.name).toBe("Beta");

  configModule.setApiEnvironmentOverride("production");
  expect(cacheModule.getNodeById("production-root")?.name).toBe("Production");
  expect(cacheModule.getNodeById("beta-root")).toBeNull();
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
