import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.WORKFLOWY_CONFIG_DIR;
const testHome = mkdtempSync(join(tmpdir(), "workflowy-cli-command-scope-"));
const testConfigDir = join(testHome, ".workflowy");

let cacheModule: typeof import("../shared/cache.ts");
let configModule: typeof import("../shared/config.ts");

beforeAll(async () => {
  process.env.HOME = testHome;
  process.env.WORKFLOWY_CONFIG_DIR = testConfigDir;
  configModule = await import("../shared/config.ts");
  cacheModule = await import("../shared/cache.ts");
});

afterEach(() => {
  cacheModule.resetCacheDb();

  const workflowyDir = join(testHome, ".workflowy");
  if (existsSync(workflowyDir)) {
    rmSync(workflowyDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  cacheModule.resetCacheDb();

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

test("node:todos only returns actual todo nodes", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    { id: "root-1", name: "Inbox", parent_id: null, modifiedAt: 100 },
    { id: "bullet-1", name: "Plain bullet", parent_id: "root-1", modifiedAt: 101 },
    { id: "todo-1", name: "Actual todo", parent_id: "root-1", data: { layoutMode: "todo" }, modifiedAt: 102 },
  ]);
  cacheModule.setTargetUuid("inbox", "root-1");

  const result = await runCli(["node:todos", "--format", "json"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as { nodes: Array<{ id: string; name: string }> };
  expect(parsed.nodes.map((node) => node.id)).toEqual(["todo-1"]);
});

test("search --target scopes cache search to the requested subtree", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    { id: "root-inbox", name: "Inbox", parent_id: null, modifiedAt: 100 },
    { id: "projects", name: "Projects", parent_id: "root-inbox", modifiedAt: 101 },
    { id: "launch-plan", name: "Launch plan", parent_id: "projects", modifiedAt: 102 },
    { id: "root-today", name: "Today", parent_id: null, modifiedAt: 103 },
    { id: "launch-retro", name: "Launch retro", parent_id: "root-today", modifiedAt: 104 },
  ]);
  cacheModule.setTargetUuid("inbox", "root-inbox");
  cacheModule.setTargetUuid("today", "root-today");

  const result = await runCli(["search", "launch", "--format", "json", "--target", "@inbox/Projects"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as { nodes: Array<{ id: string; name: string }> };
  expect(parsed.nodes.map((node) => node.id)).toEqual(["launch-plan"]);
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../wf.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
