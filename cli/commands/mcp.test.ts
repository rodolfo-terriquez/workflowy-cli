import { expect, test } from "bun:test";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetCacheDb, replaceAllNodes, setMeta } from "../shared/cache.ts";
import { saveConfig, setAccountOverride } from "../shared/config.ts";
import { cacheTargets, resetDb, saveBookmark } from "../shared/db.ts";
import { ensureMcpCacheReadyForInitialize, getMcpCliInvocation, getMcpInitializeSyncReason, isAllowedMcpOrigin, isAuthorizedMcpHttpRequest } from "./mcp.ts";

const CWD = fileURLToPath(new URL("../..", import.meta.url));

async function runMcpServer(
  input: string,
  envOverrides: Record<string, string> = {},
  commandArgs: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "cli/wf.ts", "mcp", ...commandArgs], {
    cwd: CWD,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...envOverrides },
  });

  proc.stdin.write(input);
  proc.stdin.end();

  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { code, stdout, stderr };
}

function parseJsonLines<T>(stdout: string): T[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

interface ToolCallResponse {
  id: number;
  result?: {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

function parseJsonLine<T>(stdout: string): T {
  return JSON.parse(stdout.trim()) as T;
}

async function withTempWorkflowyConfig<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
  const previousDir = process.env.WORKFLOWY_CONFIG_DIR;
  const previousAccount = process.env.WORKFLOWY_ACCOUNT;
  const configDir = mkdtempSync(join(tmpdir(), "workflowy-cli-mcp-"));
  process.env.WORKFLOWY_CONFIG_DIR = configDir;
  resetCacheDb();
  resetDb();

  try {
    saveConfig({
      activeAccount: "default",
      accounts: {
        default: { name: "default", token: "test-token" },
      },
    });
    replaceAllNodes([
      {
        id: "root-1",
        parent_id: null,
        name: "Inbox",
        note: null,
        priority: 0,
        createdAt: 1,
        modifiedAt: 1,
      },
      {
        id: "todo-1",
        parent_id: "root-1",
        name: "Buy milk",
        note: null,
        data: { layoutMode: "todo" },
        priority: 0,
        createdAt: 2,
        modifiedAt: 2,
      },
      {
        id: "note-1",
        parent_id: "root-1",
        name: "Search target",
        note: "Contains MCP smoke data",
        priority: 1,
        createdAt: 3,
        modifiedAt: 3,
      },
      {
        id: "instructions-1",
        parent_id: null,
        name: "Agent instructions",
        note: "Follow the user instructions exactly.",
        priority: 2,
        createdAt: 4,
        modifiedAt: 4,
      },
      {
        id: "projects-1",
        parent_id: null,
        name: "Projects",
        note: "Long-lived projects root",
        priority: 3,
        createdAt: 4,
        modifiedAt: 4,
      },
      {
        id: "instructions-child-1",
        parent_id: "instructions-1",
        name: "Use targets first",
        note: "Prefer @targets and cached paths before raw ids.",
        priority: 0,
        createdAt: 5,
        modifiedAt: 5,
      },
      {
        id: "instructions-child-2",
        parent_id: "instructions-1",
        name: "Resync after many writes",
        note: null,
        priority: 1,
        createdAt: 6,
        modifiedAt: 6,
      },
    ]);
    cacheTargets("default", [
      { key: "inbox", label: "Inbox", nodeId: "root-1", type: "system" },
      { key: "projects", label: "Projects", nodeId: "projects-1", type: "shortcut" },
    ]);
    saveBookmark("default", {
      name: "home",
      nodeId: "root-1",
      context: "Primary inbox bookmark",
    });

    return await fn(configDir);
  } finally {
    setAccountOverride(null);
    resetCacheDb();
    resetDb();
    if (previousDir === undefined) {
      delete process.env.WORKFLOWY_CONFIG_DIR;
    } else {
      process.env.WORKFLOWY_CONFIG_DIR = previousDir;
    }
    if (previousAccount === undefined) {
      delete process.env.WORKFLOWY_ACCOUNT;
    } else {
      process.env.WORKFLOWY_ACCOUNT = previousAccount;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
}

test("detects when MCP initialize should warm the cache for the active account", async () => {
  await withTempWorkflowyConfig(async () => {
    saveConfig({
      activeAccount: "other",
      accounts: {
        default: { name: "default", token: "test-token" },
        other: { name: "other", token: "other-token" },
      },
    });

    expect(getMcpInitializeSyncReason()).toBe("cache_empty");
  });
});

test("detects when MCP initialize should re-sync to resolve custom instructions", async () => {
  await withTempWorkflowyConfig(async () => {
    saveConfig({
      activeAccount: "default",
      accounts: {
        default: { name: "default", token: "test-token" },
      },
      mcp: {
        instructionsNode: "missing-node",
      },
    });

    expect(getMcpInitializeSyncReason()).toBe("instructions_unresolved");
  });
});

test("detects when MCP initialize should warm a hard-stale cache", async () => {
  await withTempWorkflowyConfig(async () => {
    setMeta("account:default:last_synced_at", String(Date.now() - 2 * 60 * 60 * 1000));
    expect(getMcpInitializeSyncReason()).toBe("hard_stale");
  });
});

test("runs MCP initialize cache warmup only when needed", async () => {
  await withTempWorkflowyConfig(async () => {
    let syncCalls = 0;

    await ensureMcpCacheReadyForInitialize(async () => {
      syncCalls += 1;
      return {};
    });

    expect(syncCalls).toBe(0);

    saveConfig({
      activeAccount: "default",
      accounts: {
        default: { name: "default", token: "test-token" },
      },
      mcp: {
        instructionsNode: "missing-node",
      },
    });

    await ensureMcpCacheReadyForInitialize(async () => {
      syncCalls += 1;
      saveConfig({
        activeAccount: "default",
        accounts: {
          default: { name: "default", token: "test-token" },
        },
        mcp: {
          instructionsNode: "instructions-1",
        },
      });
      return {};
    });

    expect(syncCalls).toBe(1);
    expect(getMcpInitializeSyncReason()).toBe(null);
  });
});

test("runs MCP initialize cache warmup when the cache is hard stale", async () => {
  await withTempWorkflowyConfig(async () => {
    setMeta("account:default:last_synced_at", String(Date.now() - 2 * 60 * 60 * 1000));

    let syncCalls = 0;
    await ensureMcpCacheReadyForInitialize(async () => {
      syncCalls += 1;
      replaceAllNodes([
        {
          id: "root-1",
          parent_id: null,
          name: "Inbox",
          note: null,
          priority: 0,
          createdAt: 1,
          modifiedAt: 1,
        },
      ]);
      return {};
    });

    expect(syncCalls).toBe(1);
    expect(getMcpInitializeSyncReason()).toBe(null);
  });
});

test("responds to newline-delimited initialize messages over stdio", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = JSON.parse(stdout.trim()) as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: { tools: Record<string, unknown> };
        instructions?: string;
      };
    };

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result.protocolVersion).toBe("2024-11-05");
    expect(response.result.serverInfo).toEqual({ name: "workflowy", version: "3.3.0" });
    expect(response.result.capabilities).toEqual({ tools: {} });
    expect(response.result.instructions).toContain("## STOP — Read This First");
    expect(response.result.instructions).toContain("workflowy_targets");
    expect(response.result.instructions).toContain("workflowy_batch");
    expect(response.result.instructions).toContain("Prefer `edit_doc` for creating or replacing a nested outline in one call");
    expect(response.result.instructions).toContain("use notes mostly for metadata or true note fields");
    expect(response.result.instructions).toContain("it is not expanded into nested child bullets");
    expect(response.result.instructions).toContain("@today");
    expect(response.result.instructions).toContain("<time startYear=\"2026\" startMonth=\"6\" startDay=\"3\">Jun 3, 2026</time>");
    expect(response.result.instructions).toContain("auto-refreshes the local cache");
  });
});

test("includes configured instructions in the initialize response", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    saveConfig({
      activeAccount: "default",
      accounts: {
        default: { name: "default", token: "test-token" },
      },
      mcp: {
        instructionsNode: "instructions-1",
      },
    });

    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = JSON.parse(stdout.trim()) as {
      result: { instructions?: string };
    };

    expect(response.result.instructions).toContain("## STOP — Read This First");
    expect(response.result.instructions).toContain("## User custom instructions");
    expect(response.result.instructions).toContain("Agent instructions");
    expect(response.result.instructions).toContain("Follow the user instructions exactly.");
    expect(response.result.instructions).toContain("- Use targets first");
    expect(response.result.instructions).toContain("Prefer @targets and cached paths before raw ids.");
  });
});

test("resolves configured instructions from bookmark targets", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    saveBookmark("default", {
      name: "guide",
      nodeId: "instructions-1",
      context: "Workflow guidance",
    });

    saveConfig({
      activeAccount: "default",
      accounts: {
        default: { name: "default", token: "test-token" },
      },
      mcp: {
        instructionsNode: "@guide",
      },
    });

    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = JSON.parse(stdout.trim()) as {
      result: { instructions?: string };
    };

    expect(response.result.instructions).toContain("## User custom instructions");
    expect(response.result.instructions).toContain("Agent instructions");
    expect(response.result.instructions).toContain("Resync after many writes");
  });
});

test("responds to content-length framed initialize messages over stdio", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });

    const input = `Content-Length: ${body.length}\r\n\r\n${body}`;
    const { code, stdout, stderr } = await runMcpServer(input, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.startsWith("Content-Length: ")).toBe(true);

    const separator = stdout.indexOf("\r\n\r\n");
    expect(separator).toBeGreaterThan(-1);

    const response = JSON.parse(stdout.slice(separator + 4)) as {
      result: { serverInfo: { name: string } };
    };

    expect(response.result.serverInfo.name).toBe("workflowy");
  });
});

test("parses UTF-8 content-length framing by bytes", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 14,
      method: "unknown_café_method",
    });
    const byteLength = new TextEncoder().encode(body).length;

    const { code, stdout, stderr } = await runMcpServer(
      `Content-Length: ${byteLength}\r\n\r\n${body}`,
      { WORKFLOWY_CONFIG_DIR: configDir },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Method not found: unknown_café_method");
  });
});

test("initializes without exiting when authentication is not configured", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "workflowy-cli-mcp-no-auth-"));
  try {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 15,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(parseJsonLine<{ result: { serverInfo: { name: string } } }>(stdout).result.serverInfo.name).toBe("workflowy");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("negotiates a supported current MCP protocol version", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 17,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const { stdout } = await runMcpServer(`${message}\n`, { WORKFLOWY_CONFIG_DIR: configDir });
    expect(parseJsonLine<{ result: { protocolVersion: string } }>(stdout).result.protocolVersion).toBe("2025-11-25");
  });
});

test("HTTP security accepts loopback origins and enforces optional bearer auth", () => {
  expect(isAllowedMcpOrigin(null)).toBe(true);
  expect(isAllowedMcpOrigin("http://127.0.0.1:3399")).toBe(true);
  expect(isAllowedMcpOrigin("https://attacker.example")).toBe(false);

  const previousToken = process.env.WORKFLOWY_MCP_AUTH_TOKEN;
  process.env.WORKFLOWY_MCP_AUTH_TOKEN = "test-http-token";
  try {
    expect(isAuthorizedMcpHttpRequest(new Request("http://127.0.0.1/mcp"))).toBe(false);
    expect(isAuthorizedMcpHttpRequest(new Request("http://127.0.0.1/mcp", {
      headers: { Authorization: "Bearer test-http-token" },
    }))).toBe(true);
  } finally {
    if (previousToken === undefined) delete process.env.WORKFLOWY_MCP_AUTH_TOKEN;
    else process.env.WORKFLOWY_MCP_AUTH_TOKEN = previousToken;
  }
});

test("rejects direct calls to tools excluded by --tools", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    });

    const { code, stdout, stderr } = await runMcpServer(
      `${message}\n`,
      { WORKFLOWY_CONFIG_DIR: configDir },
      ["--tools", "read"],
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const response = parseJsonLine<ToolCallResponse>(stdout);
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content[0]?.text).toContain("tool_not_allowed");
  });
});

test("tools/list explains nested outline writes and batch markdown limits", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/list",
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: {
            properties?: Record<string, { description?: string }>;
          };
        }>;
      };
    }>(stdout);

    const batchTool = response.result.tools.find((tool) => tool.name === "workflowy_batch");
    expect(batchTool).toBeDefined();
    expect(batchTool?.description).toContain("Markdown-style text is converted to Workflowy rich text");
    expect(batchTool?.description).toContain("nested outlines should use edit_doc");
    expect(batchTool?.inputSchema.properties?.ops?.description).toContain("use edit_doc for nested child bullets");
    expect(batchTool?.inputSchema.properties?.account?.description).toContain("Configured account name");

    const editDocTool = response.result.tools.find((tool) => tool.name === "edit_doc");
    expect(editDocTool).toBeDefined();
    expect(editDocTool?.description).toContain("Prefer this for nested outline writes");
    expect(editDocTool?.inputSchema.properties?.operations?.description).toContain("Prefer insert with nested item trees");
  });
});

test("uses the source entrypoint when MCP runs from bun", () => {
  expect(getMcpCliInvocation(["search", "test"], "/tmp/workflowy-cli/cli/wf.ts", "/opt/homebrew/bin/bun")).toEqual([
    "bun",
    "run",
    "/tmp/workflowy-cli/cli/wf.ts",
    "--agent",
    "search",
    "test",
  ]);
});

test("uses the compiled executable when MCP runs from a bundled binary", () => {
  expect(getMcpCliInvocation(["search", "test"], "/$bunfs/root/cli/wf.ts", "/tmp/workflowy-cli/dist/wf")).toEqual([
    "/tmp/workflowy-cli/dist/wf",
    "--agent",
    "search",
    "test",
  ]);
});

test("returns non-empty MCP tool content for cache-backed reads", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "workflowy_search",
        arguments: { query: "Search target" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.type).toBe("text");
    expect(response.result.content[0]?.text).toContain("\"command\": \"search\"");
    expect(response.result.content[0]?.text).toContain("Search target");
  });
});

test("routes an account-qualified MCP read to that account's retained cache", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    saveConfig({
      activeAccount: "default",
      accounts: {
        default: { name: "default", token: "token-default" },
        work: { name: "work", token: "token-work" },
      },
    });
    setAccountOverride("work");
    replaceAllNodes([{ id: "work-root", name: "Work root", parent_id: null }]);
    setAccountOverride(null);

    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "workflowy_read",
        arguments: { account: "work", target: "work-root" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ text: string }> };
    }>(stdout);
    const payload = JSON.parse(response.result.content[0]?.text ?? "{}") as {
      meta?: { account?: string };
      node?: { id?: string; name?: string };
    };
    expect(response.result.isError).toBe(false);
    expect(payload.meta?.account).toBe("work");
    expect(payload.node).toMatchObject({ id: "work-root", name: "Work root" });
  });
});

test("tools/list includes short alias tools and status", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { tools: Array<{ name: string; description: string }> };
    }>(stdout);

    const toolNames = response.result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("add");
    expect(toolNames).toContain("find");
    expect(toolNames).toContain("targets");
    expect(toolNames).toContain("search");
    expect(toolNames).toContain("move");
    expect(toolNames).toContain("complete");
    expect(toolNames).toContain("update");
    expect(toolNames).toContain("context");
    expect(toolNames).toContain("batch");
    expect(toolNames).toContain("edit_doc");
    expect(toolNames).toContain("workflowy_edit_doc");
    expect(toolNames).toContain("bookmarks");
    expect(toolNames).toContain("sync");
    expect(toolNames).toContain("status");

    const listBookmarksTool = response.result.tools.find((tool) => tool.name === "list_bookmarks");
    const bookmarksTool = response.result.tools.find((tool) => tool.name === "bookmarks");
    const saveBookmarkTool = response.result.tools.find((tool) => tool.name === "save_bookmark");
    expect(listBookmarksTool?.description).toContain("START EVERY CONVERSATION HERE");
    expect(listBookmarksTool?.description).toContain("configured custom MCP instructions");
    expect(bookmarksTool?.description).toContain("START EVERY CONVERSATION HERE");
    expect(saveBookmarkTool?.description).toContain("future agents");
  });
});

test("returns available targets through MCP", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "workflowy_targets",
        arguments: {},
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toContain("\"command\": \"targets\"");
    expect(response.result.content[0]?.text).toContain("\"id\": \"projects\"");
  });
});

test("returns saved bookmarks through MCP", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "list_bookmarks",
        arguments: {},
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);
    const payload = JSON.parse(response.result.content[0]?.text ?? "{}") as {
      meta?: { command?: string };
      _instructions?: string;
      action_required?: string;
      bookmarks?: Array<{ name?: string; context?: string | null }>;
    };

    expect(response.result.isError).toBe(false);
    expect(payload.meta?.command).toBe("bookmark:list");
    expect(payload._instructions).toContain("READ THIS FIRST");
    expect(payload.action_required).toContain("No custom MCP instructions node is configured");
    expect(payload.bookmarks?.[0]?.name).toBe("home");
    expect(payload.bookmarks?.[0]?.context).toBe("Primary inbox bookmark");
  });
});

test("returns saved bookmarks through the short MCP alias", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "bookmarks",
        arguments: {},
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);
    const payload = JSON.parse(response.result.content[0]?.text ?? "{}") as {
      meta?: { command?: string };
      _instructions?: string;
      bookmarks?: Array<{ name?: string }>;
    };

    expect(response.result.isError).toBe(false);
    expect(payload.meta?.command).toBe("bookmark:list");
    expect(payload._instructions).toContain("Prefer bookmark node_ids or @bookmark targets");
    expect(payload.bookmarks?.[0]?.name).toBe("home");
  });
});

test("returns configured custom instructions through bookmarks MCP response", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    saveConfig({
      activeAccount: "default",
      accounts: {
        default: { name: "default", token: "test-token" },
      },
      mcp: {
        instructionsNode: "instructions-1",
      },
    });

    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "bookmarks",
        arguments: {},
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);
    const payload = JSON.parse(response.result.content[0]?.text ?? "{}") as {
      user_instructions?: string;
      action_required?: string;
    };

    expect(response.result.isError).toBe(false);
    expect(payload.user_instructions).toContain("Agent instructions");
    expect(payload.user_instructions).toContain("Follow the user instructions exactly.");
    expect(payload.action_required).toBeUndefined();
  });
});

test("reads nodes through the short MCP alias", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "read",
        arguments: { target: "@inbox" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toContain("\"command\": \"node:read\"");
    expect(response.result.content[0]?.text).toContain("\"resolved_id\": \"root-1\"");
  });
});

test("finds nodes through the short MCP alias", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "find",
        arguments: { query: "Search target" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toContain("\"command\": \"node:find\"");
    expect(response.result.content[0]?.text).toContain("Search target");
  });
});

test("targets and search aliases work through MCP", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const targetsMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "targets",
        arguments: {},
      },
    });

    const searchMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "search",
        arguments: { query: "MCP smoke" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${targetsMessage}\n${searchMessage}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const responses = parseJsonLines<ToolCallResponse>(stdout);
    expect(responses).toHaveLength(2);
    expect(responses[0]?.result?.isError).toBe(false);
    expect(responses[0]?.result?.content[0]?.text).toContain("\"command\": \"targets\"");
    expect(responses[1]?.result?.isError).toBe(false);
    expect(responses[1]?.result?.content[0]?.text).toContain("\"command\": \"search\"");
    expect(responses[1]?.result?.content[0]?.text).toContain("Search target");
  });
});

test("status returns diagnostic output through MCP even when unhealthy", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    saveConfig({
      activeAccount: "default",
      accounts: {
        default: { name: "default", token: "" },
      },
    });

    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "status",
        arguments: {},
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toContain("\"command\": \"doctor\"");
    expect(response.result.content[0]?.text).toContain("\"healthy\": false");
    expect(response.result.content[0]?.text).toContain("\"ready\": false");
    expect(response.result.content[0]?.text).toContain("\"suggested_actions\"");
  });
});

test("saves bookmarks through MCP and resolves them in reads", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const saveMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "save_bookmark",
        arguments: {
          name: "work",
          target: "@projects",
          context: "Projects root",
        },
      },
    });

    const saveResult = await runMcpServer(`${saveMessage}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(saveResult.code).toBe(0);
    expect(saveResult.stderr).toBe("");

    const saveResponse = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(saveResult.stdout);

    expect(saveResponse.result.isError).toBe(false);
    expect(saveResponse.result.content[0]?.text).toContain("\"command\": \"bookmark:save\"");
    expect(saveResponse.result.content[0]?.text).toContain("\"name\": \"work\"");
    expect(saveResponse.result.content[0]?.text).toContain("\"node_id\": \"projects-1\"");

    const readMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "workflowy_read",
        arguments: { target: "@work" },
      },
    });

    const readResult = await runMcpServer(`${readMessage}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(readResult.code).toBe(0);
    expect(readResult.stderr).toBe("");

    const readResponse = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(readResult.stdout);

    expect(readResponse.result.isError).toBe(false);
    expect(readResponse.result.content[0]?.text).toContain("\"resolved_id\": \"projects-1\"");
    expect(readResponse.result.content[0]?.text).toContain("Projects");
  });
});

test("runs batch through MCP instead of returning unknown_tool", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "workflowy_batch",
        arguments: {
          ops: [
            { op: "add", to: "@inbox", text: "Created from MCP batch" },
          ],
        },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);

    expect(response.result.content[0]?.text.length ?? 0).toBeGreaterThan(0);
    expect(response.result.content[0]?.text).toContain("batch");
    expect(response.result.content[0]?.text).not.toContain("unknown_tool");
  });
});

test("returns MCP tool errors instead of blank text when the CLI call fails", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "workflowy_read",
        arguments: { target: "@today" },
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${message}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const response = parseJsonLine<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(stdout);

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text.length).toBeGreaterThan(0);
    expect(response.result.content[0]?.text).toContain("node_not_found");
  });
});

test("keeps serving requests after an unknown tool call in the same session", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const unknownTool = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "workflowy_missing_tool",
        arguments: {},
      },
    });

    const validTool = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "workflowy_targets",
        arguments: {},
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${unknownTool}\n${validTool}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const responses = parseJsonLines<ToolCallResponse>(stdout);

    expect(responses).toHaveLength(2);
    expect(responses[0]?.id).toBe(9);
    expect(responses[0]?.result?.isError).toBe(true);
    expect(responses[0]?.result?.content[0]?.text).toContain("unknown_tool");

    expect(responses[1]?.id).toBe(10);
    expect(responses[1]?.result?.isError).toBe(false);
    expect(responses[1]?.result?.content[0]?.text).toContain("\"command\": \"targets\"");
  });
});

test("returns invalid params without crashing when tools/call params are missing", async () => {
  await withTempWorkflowyConfig(async (configDir) => {
    const invalidCall = JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
    });

    const validTool = JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "workflowy_targets",
        arguments: {},
      },
    });

    const { code, stdout, stderr } = await runMcpServer(`${invalidCall}\n${validTool}\n`, {
      WORKFLOWY_CONFIG_DIR: configDir,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");

    const responses = parseJsonLines<ToolCallResponse>(stdout);

    expect(responses).toHaveLength(2);
    expect(responses[0]?.id).toBe(11);
    expect(responses[0]?.error?.code).toBe(-32602);
    expect(responses[0]?.error?.message).toContain("Invalid params");

    expect(responses[1]?.id).toBe(12);
    expect(responses[1]?.result?.isError).toBe(false);
    expect(responses[1]?.result?.content[0]?.text).toContain("\"command\": \"targets\"");
  });
});
