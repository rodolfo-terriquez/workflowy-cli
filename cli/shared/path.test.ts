import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.WORKFLOWY_CONFIG_DIR;
const testHome = mkdtempSync(join(tmpdir(), "workflowy-cli-path-"));
const testConfigDir = join(testHome, ".workflowy");

let cacheModule: typeof import("./cache.ts");
let configModule: typeof import("./config.ts");
let dbModule: typeof import("./db.ts");
let pathModule: typeof import("./path.ts");

beforeAll(async () => {
  process.env.HOME = testHome;
  process.env.WORKFLOWY_CONFIG_DIR = testConfigDir;
  configModule = await import("./config.ts");
  cacheModule = await import("./cache.ts");
  dbModule = await import("./db.ts");
  pathModule = await import("./path.ts");
});

afterEach(() => {
  configModule.setAccountOverride(null);
  cacheModule.resetCacheDb();
  dbModule.resetDb();
  if (existsSync(testConfigDir)) rmSync(testConfigDir, { recursive: true, force: true });
});

afterAll(() => {
  cacheModule.resetCacheDb();
  dbModule.resetDb();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.WORKFLOWY_CONFIG_DIR;
  else process.env.WORKFLOWY_CONFIG_DIR = originalConfigDir;
  rmSync(testHome, { recursive: true, force: true });
});

test("write targets preserve an unmaterialized built-in Calendar key", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "test-token" } },
  });

  expect(pathModule.resolveTargetReference("@today")).toBeNull();
  expect(pathModule.resolveWriteTargetReference("@today")).toEqual({
    id: "today",
    label: "@today",
    source: "builtin",
  });
  expect(pathModule.resolveWriteTargetReference("@next-week")?.id).toBe("next_week");
});

test("write targets prefer a local bookmark over the built-in system target", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "test-token" } },
  });
  cacheModule.replaceAllNodes([
    { id: "real-inbox", name: "📥 Inbox", parent_id: null, modifiedAt: 1 },
  ]);
  dbModule.saveBookmark("default", {
    name: "inbox",
    nodeId: "real-inbox",
    context: "Rodolfo's real inbox",
  });

  expect(pathModule.resolveWriteTargetReference("@inbox")).toEqual({
    id: "real-inbox",
    label: "@inbox",
    source: "builtin",
  });
});

test("write targets keep using a materialized Calendar node when one is cached", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "test-token" } },
  });
  cacheModule.replaceAllNodes([
    { id: "today-node", name: "Today", parent_id: "calendar", modifiedAt: 1 },
  ]);
  cacheModule.setTargetUuid("today", "today-node");

  expect(pathModule.resolveWriteTargetReference("@today")?.id).toBe("today-node");
});

test("write targets do not pretend an unresolved path can be created server-side", () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "test-token" } },
  });

  expect(pathModule.resolveWriteTargetReference("@today/Meetings")).toBeNull();
});
