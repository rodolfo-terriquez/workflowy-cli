import { expect, test } from "bun:test";
import { fileURLToPath } from "url";

const CWD = fileURLToPath(new URL("../..", import.meta.url));

async function runMcpServer(input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "cli/wf.ts", "mcp"], {
    cwd: CWD,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
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
