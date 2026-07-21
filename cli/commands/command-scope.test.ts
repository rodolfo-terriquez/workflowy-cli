import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.WORKFLOWY_CONFIG_DIR;
const originalAccount = process.env.WORKFLOWY_ACCOUNT;
const originalApiEnvironment = process.env.WORKFLOWY_API_ENVIRONMENT;
const testHome = mkdtempSync(join(tmpdir(), "workflowy-cli-command-scope-"));
const testConfigDir = join(testHome, ".workflowy");

let cacheModule: typeof import("../shared/cache.ts");
let configModule: typeof import("../shared/config.ts");
let dbModule: typeof import("../shared/db.ts");
let doctorModule: typeof import("./doctor.ts");

beforeAll(async () => {
  process.env.HOME = testHome;
  process.env.WORKFLOWY_CONFIG_DIR = testConfigDir;
  delete process.env.WORKFLOWY_ACCOUNT;
  delete process.env.WORKFLOWY_API_ENVIRONMENT;
  configModule = await import("../shared/config.ts");
  cacheModule = await import("../shared/cache.ts");
  dbModule = await import("../shared/db.ts");
  doctorModule = await import("./doctor.ts");
});

afterEach(() => {
  configModule.setAccountOverride(null);
  configModule.setApiEnvironmentOverride(null);
  cacheModule.resetCacheDb();
  dbModule.resetDb();

  const workflowyDir = join(testHome, ".workflowy");
  if (existsSync(workflowyDir)) {
    rmSync(workflowyDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  cacheModule.resetCacheDb();
  dbModule.resetDb();

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

test("read alias resolves to node:read", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    { id: "root-1", name: "Inbox", parent_id: null, modifiedAt: 100 },
    { id: "child-1", name: "Alias target", parent_id: "root-1", modifiedAt: 101 },
  ]);
  cacheModule.setTargetUuid("inbox", "root-1");

  const result = await runCli(["read", "@inbox", "--format", "json"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as { meta: { command: string }; node: { id: string }; children: Array<{ id: string; name: string }> };
  expect(parsed.meta.command).toBe("node:read");
  expect(parsed.node.id).toBe("root-1");
  expect(parsed.children.map((node) => node.id)).toEqual(["child-1"]);
});

test("node:read resolves short UUID prefixes from the cache", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    {
      id: "a5de1cca-1b91-ed4f-bc34-ec5e2aec6bd9",
      name: "Week 23 (Jun 1-5, 2026)",
      parent_id: null,
      modifiedAt: 100,
    },
  ]);

  const result = await runCli(["node:read", "a5de1cca", "--format", "json"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as { meta: { resolved_id: string }; node: { id: string; name: string } };
  expect(parsed.meta.resolved_id).toBe("a5de1cca-1b91-ed4f-bc34-ec5e2aec6bd9");
  expect(parsed.node.id).toBe("a5de1cca-1b91-ed4f-bc34-ec5e2aec6bd9");
  expect(parsed.node.name).toBe("Week 23 (Jun 1-5, 2026)");
});

test("sync alias resolves to cache:sync status mode without hitting the API", async () => {
  const result = await runCli(["--agent", "sync", "--status"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as { meta: { command: string; mode: string } };
  expect(parsed.meta.command).toBe("cache:sync");
  expect(parsed.meta.mode).toBe("status");
});

test("sync --all-accounts reports a structured error when no accounts are configured", async () => {
  const result = await runCli(["--agent", "sync", "--all-accounts"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("account_not_found");
});

test("bookmarks alias resolves to bookmark:list", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    { id: "root-1", name: "Inbox", parent_id: null, modifiedAt: 100 },
  ]);
  dbModule.saveBookmark("default", {
    name: "home",
    nodeId: "root-1",
    context: "Primary inbox bookmark",
  });

  const result = await runCli(["bookmarks", "--format", "json"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as { meta: { command: string }; bookmarks: Array<{ name: string; context: string | null }> };
  expect(parsed.meta.command).toBe("bookmark:list");
  expect(parsed.bookmarks[0]?.name).toBe("home");
  expect(parsed.bookmarks[0]?.context).toBe("Primary inbox bookmark");
});

test("targets use bookmark node names and keep context separate", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    { id: "root-1", name: "📥 Inbox", parent_id: null, modifiedAt: 100 },
  ]);
  dbModule.cacheTargets("default", [
    { key: "inbox", label: "Inbox", nodeId: "root-1", type: "system" },
  ]);
  dbModule.saveBookmark("default", {
    name: "inbox",
    nodeId: "root-1",
    context: "Top-level inbox — capture point for quick ideas.",
  });

  const result = await runCli(["targets", "--agent"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as {
    nodes: Array<{
      id: string;
      kind: string;
      name: string;
      context: string | null;
      node_id: string | null;
      path: string | null;
    }>;
  };
  const inbox = parsed.nodes.find((node) => node.id === "inbox");
  expect(inbox).toMatchObject({
    id: "inbox",
    kind: "bookmark",
    name: "📥 Inbox",
    context: "Top-level inbox — capture point for quick ideas.",
    node_id: "root-1",
    path: "📥 Inbox",
  });
});

test("doctor treats missing optional LLM key as warning when core setup is ready", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });
  cacheModule.replaceAllNodes([
    { id: "root-1", name: "Inbox", parent_id: null, modifiedAt: 100 },
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

  try {
    const report = await doctorModule.collectDoctorReport();
    const llmKeyCheck = report.checks.find((check) => check.label === "LLM API key");

    expect(report.ready).toBe(true);
    expect(report.healthy).toBe(true);
    expect(llmKeyCheck).toMatchObject({
      ok: true,
      warn: true,
      detail: "missing — set securely with `printf %s \"$LLM_API_KEY\" | wf config:set llm.apiKey --stdin`",
    });
    expect(report.suggested_actions).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status and auth status both run doctor with structured readiness output", async () => {
  const statusResult = await runCli(["--agent", "status"]);
  expect(statusResult.exitCode).toBe(1);

  const statusParsed = JSON.parse(statusResult.stdout) as {
    meta: { command: string };
    healthy: boolean;
    ready: boolean;
    account: { active: string; configured: boolean };
    auth: { token_present: boolean; valid: boolean };
    api: { checked: boolean; reachable: boolean; ok: boolean; status_code: number | null };
    cache: { db_exists: boolean; present: boolean; node_count: number; cache_stale: boolean };
    suggested_actions: string[];
  };
  expect(statusParsed.meta.command).toBe("doctor");
  expect(statusParsed.healthy).toBe(false);
  expect(typeof statusParsed.ready).toBe("boolean");
  expect(statusParsed.account.active).toBe("default");
  expect(statusParsed.auth.token_present).toBe(false);
  expect(statusParsed.auth.valid).toBe(false);
  expect(statusParsed.api.checked).toBe(false);
  expect(statusParsed.cache.cache_stale).toBe(true);
  expect(statusParsed.suggested_actions).toContain("wf login");
  expect(statusParsed.suggested_actions).toContain("wf sync");

  const authStatusResult = await runCli(["--agent", "auth", "status"]);
  expect(authStatusResult.exitCode).toBe(1);

  const authStatusParsed = JSON.parse(authStatusResult.stdout) as { meta: { command: string }; ready: boolean; suggested_actions: string[] };
  expect(authStatusParsed.meta.command).toBe("doctor");
  expect(typeof authStatusParsed.ready).toBe("boolean");
  expect(authStatusParsed.suggested_actions).toContain("wf status");
});

test("unknown command errors include suggestions and help hints", async () => {
  const topLevelResult = await runCli(["bookmarkss"], { CI: "", WF_AGENT: "", TERM: "xterm-256color" });
  expect(topLevelResult.exitCode).toBe(1);
  expect(topLevelResult.stderr).toContain("Did you mean bookmarks?");
  expect(topLevelResult.stderr).toContain("Run `wf --help` to see available commands.");

  const authResult = await runCli(["auth", "sttaus"], { CI: "", WF_AGENT: "", TERM: "xterm-256color" });
  expect(authResult.exitCode).toBe(1);
  expect(authResult.stderr).toContain("Did you mean status?");
  expect(authResult.stderr).toContain("Run `wf auth --help` to see auth commands.");
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

  const aliasResult = await runCli(["todos", "--format", "json"]);
  expect(aliasResult.exitCode).toBe(0);
  const aliasParsed = JSON.parse(aliasResult.stdout) as { nodes: Array<{ id: string; name: string }> };
  expect(aliasParsed.nodes.map((node) => node.id)).toEqual(["todo-1"]);
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

test("search --target resolves full saved target IDs to cached short IDs", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    { id: "111111111111", name: "Inbox", parent_id: null, modifiedAt: 100 },
    { id: "222222222222", name: "Projects", parent_id: "111111111111", modifiedAt: 101 },
    { id: "333333333333", name: "Scoped video note", parent_id: "222222222222", modifiedAt: 102 },
    { id: "444444444444", name: "Unscoped video note", parent_id: null, modifiedAt: 103 },
  ]);
  cacheModule.setTargetUuid("inbox", "aaaaaaaa-bbbb-cccc-dddd-111111111111");

  const result = await runCli(["search", "video", "--format", "json", "--target", "@inbox/Projects"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as { nodes: Array<{ id: string; name: string }> };
  expect(parsed.nodes.map((node) => node.id)).toEqual(["333333333333"]);
});

test("search --target applies scope before limiting global results", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    { id: "root-today", name: "Today", parent_id: null, modifiedAt: 100 },
    { id: "outside-match", name: "Needle outside target", parent_id: "root-today", modifiedAt: 101 },
    { id: "root-inbox", name: "Inbox", parent_id: null, modifiedAt: 102 },
    { id: "projects", name: "Projects", parent_id: "root-inbox", modifiedAt: 103 },
    { id: "inside-match", name: "Needle inside target", parent_id: "projects", modifiedAt: 104 },
  ]);
  cacheModule.setTargetUuid("inbox", "root-inbox");
  cacheModule.setTargetUuid("today", "root-today");

  const result = await runCli(["search", "needle", "--format", "json", "--target", "@inbox/Projects", "--limit", "1"]);
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout) as { nodes: Array<{ id: string; name: string }> };
  expect(parsed.nodes.map((node) => node.id)).toEqual(["inside-match"]);
});

test("node:delete requires --yes in non-interactive mode", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
    },
  });

  cacheModule.replaceAllNodes([
    { id: "root-1", name: "Inbox", parent_id: null, modifiedAt: 100 },
    { id: "child-1", name: "Delete me", parent_id: "root-1", modifiedAt: 101 },
  ]);

  const result = await runCli(["node:delete", "Delete me"], { CI: "", WF_AGENT: "", TERM: "xterm-256color" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Refusing to delete");
  expect(result.stderr).toContain("--yes");
});

test("bulk delete requires an explicit scope and confirmation", async () => {
  const unscoped = await runCli(["--agent", "bulk", "delete"]);
  expect(unscoped.exitCode).toBe(1);
  expect(JSON.parse(unscoped.stdout).error.code).toBe("scope_required");

  const unconfirmed = await runCli(["--agent", "bulk", "delete", "--target", "@inbox"]);
  expect(unconfirmed.exitCode).toBe(1);
  expect(JSON.parse(unconfirmed.stdout).error.code).toBe("confirmation_required");
});

test("config:get redacts sensitive values by default", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "secret-token" } },
    llm: { apiKey: "secret-llm-key" },
  });

  const result = await runCli(["--agent", "config:get", "llm.apiKey"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).value).toBe("[redacted]");
  expect(result.stdout).not.toContain("secret-llm-key");

  const parentResult = await runCli(["--agent", "config:get", "llm"]);
  expect(JSON.parse(parentResult.stdout).value.apiKey).toBe("[redacted]");
  expect(parentResult.stdout).not.toContain("secret-llm-key");
});

test("config:set accepts secret values from stdin without echoing them", async () => {
  const result = await runCli(
    ["--agent", "config:set", "llm.apiKey", "--stdin"],
    {},
    "secret-from-stdin\n",
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).value).toBe("[redacted]");
  expect(result.stdout).not.toContain("secret-from-stdin");
  expect(configModule.loadConfig().llm?.apiKey).toBe("secret-from-stdin");
});

test("config:set validates and normalizes the public API environment", async () => {
  const beta = await runCli(["--agent", "config:set", "api.environment", "beta"]);
  expect(beta.exitCode).toBe(0);
  expect(JSON.parse(beta.stdout).value).toBe("beta");
  expect(configModule.loadConfig().api?.environment).toBe("beta");

  const production = await runCli(["--agent", "config:set", "api.environment", "prod"]);
  expect(production.exitCode).toBe(0);
  expect(JSON.parse(production.stdout).value).toBe("production");
  expect(configModule.loadConfig().api?.environment).toBe("production");

  const invalid = await runCli(["--agent", "config:set", "api.environment", "staging"]);
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stdout).error.code).toBe("invalid_api_environment");
  expect(configModule.loadConfig().api?.environment).toBe("production");
});

test("path traversal refuses ambiguous partial child matches", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "token-default" } },
  });
  cacheModule.replaceAllNodes([
    { id: "root-1", name: "Inbox", parent_id: null, modifiedAt: 100 },
    { id: "project-a", name: "Project Alpha", parent_id: "root-1", modifiedAt: 101 },
    { id: "project-b", name: "Project Beta", parent_id: "root-1", modifiedAt: 102 },
  ]);
  cacheModule.setTargetUuid("inbox", "root-1");

  const result = await runCli(["--agent", "read", "@inbox/Project"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("node_not_found");
});

test("--account reads another retained cache without switching the configured default", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: {
      default: { name: "default", token: "token-default" },
      work: { name: "work", token: "token-work" },
    },
  });
  cacheModule.replaceAllNodes([{ id: "default-root", name: "Default root", parent_id: null }]);

  configModule.setAccountOverride("work");
  cacheModule.replaceAllNodes([{ id: "work-root", name: "Work root", parent_id: null }]);
  configModule.setAccountOverride(null);

  const result = await runCli(["--account", "work", "--agent", "read", "work-root"]);
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout) as { meta: { account: string }; node: { id: string; name: string } };
  expect(parsed.meta.account).toBe("work");
  expect(parsed.node).toMatchObject({ id: "work-root", name: "Work root" });
  expect(configModule.loadConfig().activeAccount).toBe("default");

  const defaultResult = await runCli(["--agent", "read", "default-root"]);
  expect(defaultResult.exitCode).toBe(0);
  expect(JSON.parse(defaultResult.stdout).meta.account).toBe("default");
});

test("--account rejects unknown account names before command execution", async () => {
  configModule.saveConfig({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "token-default" } },
  });

  const result = await runCli(["--account", "missing", "--agent", "account:current"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("account_not_found");
});

test("mirror commands require an explicit beta API selection", async () => {
  const productionResult = await runCli(["--agent", "mirror:info", "abcdef123456"]);
  expect(productionResult.exitCode).toBe(1);
  expect(JSON.parse(productionResult.stdout).error.code).toBe("beta_api_required");

  const betaResult = await runCli(["--beta", "--agent", "cache:sync", "--status"]);
  expect(betaResult.exitCode).toBe(0);
  expect(JSON.parse(betaResult.stdout).meta.api_environment).toBe("beta");
});

async function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
  stdin = "",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../wf.ts"), ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...envOverrides },
  });

  if (stdin) proc.stdin.write(stdin);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
