import { expect, test } from "bun:test";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetCacheDb, replaceAllNodes } from "../shared/cache.ts";
import { saveConfig } from "../shared/config.ts";
import { cacheTargets, resetDb, saveBookmark } from "../shared/db.ts";
import { getMcpCliInvocation } from "./mcp.ts";

const CWD = fileURLToPath(new URL("../..", import.meta.url));

async function runMcpServer(
  input: string,
  envOverrides: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "cli/wf.ts", "mcp"], {
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

function parseJsonLine<T>(stdout: string): T {
  return JSON.parse(stdout.trim()) as T;
}

async function withTempWorkflowyConfig<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
  const previousDir = process.env.WORKFLOWY_CONFIG_DIR;
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
    resetCacheDb();
    resetDb();
    if (previousDir === undefined) {
      delete process.env.WORKFLOWY_CONFIG_DIR;
    } else {
      process.env.WORKFLOWY_CONFIG_DIR = previousDir;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
}

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
      };
    };

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "workflowy", version: "3.0.3" },
        capabilities: { tools: {} },
      },
    });
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

    expect(response.result.instructions).toContain("Agent instructions");
    expect(response.result.instructions).toContain("Follow the user instructions exactly.");
    expect(response.result.instructions).toContain("- Use targets first");
    expect(response.result.instructions).toContain("Prefer @targets and cached paths before raw ids.");
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

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toContain("\"command\": \"bookmark:list\"");
    expect(response.result.content[0]?.text).toContain("\"name\": \"home\"");
    expect(response.result.content[0]?.text).toContain("Primary inbox bookmark");
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

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toContain("\"command\": \"batch\"");
    expect(response.result.content[0]?.text).toContain("\"total_operations\": 1");
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
