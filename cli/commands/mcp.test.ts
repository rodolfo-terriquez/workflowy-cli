import { expect, test } from "bun:test";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetCacheDb, replaceAllNodes } from "../shared/cache.ts";
import { saveConfig } from "../shared/config.ts";

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

  try {
    saveConfig({ activeAccount: "default", accounts: {} });
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
    ]);

    return await fn(configDir);
  } finally {
    resetCacheDb();
    if (previousDir === undefined) {
      delete process.env.WORKFLOWY_CONFIG_DIR;
    } else {
      process.env.WORKFLOWY_CONFIG_DIR = previousDir;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
}

test("responds to newline-delimited initialize messages over stdio", async () => {
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

  const { code, stdout, stderr } = await runMcpServer(`${message}\n`);

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
      serverInfo: { name: "workflowy", version: "3.0.0" },
      capabilities: { tools: {} },
    },
  });
});

test("responds to content-length framed initialize messages over stdio", async () => {
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
  const { code, stdout, stderr } = await runMcpServer(input);

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
