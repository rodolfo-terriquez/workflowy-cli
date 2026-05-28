import type { Command } from "commander";
import chalk from "chalk";
import { isAgentMode } from "../agent.ts";
import { loadConfig } from "../shared/config.ts";
import { getCacheNodeCount, getChildren, getNodeById, type CachedNode } from "../shared/cache.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { resolveCacheTargetReference } from "../shared/path.ts";
import { doSync } from "./sync.ts";

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolCallResult {
  text: string;
  isError?: boolean;
}

export function getMcpCliInvocation(cmdArgs: string[], mainPath = Bun.main, execPath = process.execPath): string[] {
  if (mainPath && !mainPath.startsWith("/$bunfs/")) {
    return ["bun", "run", mainPath, "--agent", ...cmdArgs];
  }

  return [execPath, "--agent", ...cmdArgs];
}

const DEFAULT_MCP_INSTRUCTIONS = `This MCP server connects to a user's WorkFlowy account through \`wf\`, a CLI designed for agents, automations, and power users. WorkFlowy is a nested outline where information is stored as nodes with text, optional notes, and children.

## STOP — Read This First

Before making tool calls, follow this checklist:

1. Prefer \`status\` first when you need to check whether auth, API access, or cache state may block the next step.
2. Prefer \`workflowy_targets\` and/or \`bookmarks\` early when you need to discover saved locations, bookmarks, or user guidance.
3. Prefer \`@targets\`, bookmarks, and cached paths before asking for or relying on raw node IDs.
4. Use \`read\` or \`workflowy_context\` before structural or destructive changes when surrounding context matters.
5. Use \`workflowy_batch\` for grouped changes. A single add operation may contain a full multi-line markdown document in \`text\`.
6. If cached paths or lookups seem stale or missing, call \`sync\` and retry.
7. If the user shares a WorkFlowy link, extract the hex ID after \`#/\` and use that as the node ID.

## Key Concepts

- Read results use a stable JSON shape with \`meta\`, \`node\`, and \`children[]\`.
- Targets may be built-in locations such as \`@inbox\`, \`@today\`, \`@tomorrow\`, \`@calendar\`, and \`@next-week\`.
- Targets may also be bookmarks, raw node IDs, or cached paths such as \`@inbox/Projects/Q2\`.
- Most reads are cache-first. Some tools support live API reads or searches when needed.
- Node names and paths may be ambiguous. Do not guess when multiple matches exist.

## Common Workflows

- To inspect a subtree: use \`read\`.
- To understand a node in context: use \`workflowy_context\`.
- To find something by text: use \`workflowy_search\`.
- To add a new node: use \`workflowy_add\`.
- To rename or change a note: use \`workflowy_update\`.
- To move, complete, or delete multiple things together: prefer \`workflowy_batch\`.

## Common Mistakes to Avoid

- Do not assume the cache is current if a path lookup fails; try \`sync\`.
- Do not guess between ambiguous matches; ask or disambiguate.
- Do not split multi-line markdown into many add operations unless you want separate nodes.
- Do not use raw node IDs when a stable target or cached path is available.
- Do not make multiple write calls when one batch call will do.

## Tips

- \`status\` helps you detect auth, API, and cache issues before other tool calls.
- \`workflowy_targets\` helps you learn what the account exposes.
- \`bookmarks\` may include bookmark context notes that help with navigation.
- \`workflowy_context\` is often better than a deep read when you need nearby siblings and ancestors.
- Use smaller reads first, then expand depth only if needed.`;

let mcpInitializeSyncPromise: Promise<void> | null = null;

function getInitializeInstructions(maxDepth = 4): string {
  const parts = [DEFAULT_MCP_INSTRUCTIONS];
  const userInstructions = getUserInitializeInstructions(maxDepth);

  if (userInstructions) {
    parts.push(`## User custom instructions\n\n${userInstructions}`);
  }

  return parts.join("\n\n").trim();
}

function getUserInitializeInstructions(maxDepth = 4): string | null {
  const configured = loadConfig().mcp?.instructionsNode?.trim();
  if (!configured) return null;

  const node = resolveInstructionsNode(configured);
  if (!node) return null;

  const lines = flattenInstructionsNode(node, 0, maxDepth);
  const instructions = lines.join("\n").trim();
  return instructions.length > 0 ? instructions : null;
}

function resolveInstructionsNode(configured: string): CachedNode | null {
  const resolved = resolveCacheTargetReference(configured);
  if (!resolved) return null;

  return getNodeById(resolved.id);
}

export function getMcpInitializeSyncReason(): "cache_empty" | "instructions_unresolved" | null {
  if (getCacheNodeCount() === 0) {
    return "cache_empty";
  }

  const configured = loadConfig().mcp?.instructionsNode?.trim();
  if (!configured) return null;

  return resolveInstructionsNode(configured) ? null : "instructions_unresolved";
}

export async function ensureMcpCacheReadyForInitialize(
  syncFn: (opts?: { silent?: boolean }) => Promise<unknown> = doSync,
): Promise<boolean> {
  const reason = getMcpInitializeSyncReason();
  if (!reason) return false;

  if (!mcpInitializeSyncPromise) {
    mcpInitializeSyncPromise = (async () => {
      try {
        await syncFn({ silent: true });
      } catch {
        // Best-effort warmup only. MCP initialization should still succeed even if sync fails.
      } finally {
        mcpInitializeSyncPromise = null;
      }
    })();
  }

  await mcpInitializeSyncPromise;
  return true;
}

function flattenInstructionsNode(node: CachedNode, depth: number, maxDepth: number): string[] {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  const name = cleanHtml(node.name);
  const note = node.note ? cleanHtml(node.note) : null;

  if (name) {
    lines.push(depth === 0 ? name : `${indent}- ${name}`);
  }

  if (note) {
    lines.push(`${indent}${depth === 0 ? "" : "  "}${note}`);
  }

  if (depth >= maxDepth) {
    return lines;
  }

  for (const child of getChildren(node.id)) {
    lines.push(...flattenInstructionsNode(child, depth + 1, maxDepth));
  }

  return lines;
}

const MCP_TOOLS: McpTool[] = [
  {
    name: "workflowy_read",
    description: "Read a WorkFlowy node and its children",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Node target (@inbox, @today, node ID, or path)" },
        depth: { type: "number", description: "Max depth to read", default: 3 },
        live: { type: "boolean", description: "Bypass cache", default: false },
      },
      required: ["target"],
    },
  },
  {
    name: "read",
    description: "Read a WorkFlowy node and its children (short alias of workflowy_read)",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Node target (@inbox, @today, node ID, or path)" },
        depth: { type: "number", description: "Max depth to read", default: 3 },
        live: { type: "boolean", description: "Bypass cache", default: false },
      },
      required: ["target"],
    },
  },
  {
    name: "workflowy_add",
    description: "Add a new node",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Node text" },
        to: { type: "string", description: "Target parent", default: "@inbox" },
        type: { type: "string", enum: ["bullet", "todo", "h1", "h2", "h3"], default: "bullet" },
        note: { type: "string", description: "Note content" },
      },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add a new node (short alias of workflowy_add)",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Node text" },
        to: { type: "string", description: "Target parent", default: "@inbox" },
        type: { type: "string", enum: ["bullet", "todo", "h1", "h2", "h3"], default: "bullet" },
        note: { type: "string", description: "Note content" },
      },
      required: ["text"],
    },
  },
  {
    name: "workflowy_find",
    description: "Find nodes by name or path",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, path, or @target" },
        target: { type: "string", description: "Scope search to subtree" },
      },
      required: ["query"],
    },
  },
  {
    name: "find",
    description: "Find nodes by name or path (short alias of workflowy_find)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, path, or @target" },
        target: { type: "string", description: "Scope search to subtree" },
      },
      required: ["query"],
    },
  },
  {
    name: "workflowy_todos",
    description: "List open or completed todos",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Scope to subtree" },
        completed: { type: "boolean", description: "Show completed instead", default: false },
        since: { type: "string", description: "Time window (e.g. 2h, 7d)" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "workflowy_tags",
    description: "List all hashtags with counts",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Scope to subtree" },
        filter: { type: "string", description: "Filter tags by substring" },
      },
    },
  },
  {
    name: "workflowy_targets",
    description: "List available WorkFlowy targets (system targets and bookmarks)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "targets",
    description: "List available WorkFlowy targets (short alias of workflowy_targets)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_bookmarks",
    description: "List saved local bookmarks and their target nodes",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "bookmarks",
    description: "List saved local bookmarks and their target nodes (short alias of list_bookmarks)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "save_bookmark",
    description: "Save or update a local bookmark for a WorkFlowy node",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bookmark name, with or without @" },
        target: { type: "string", description: "Target node reference (@target, path, or node ID)" },
        context: { type: "string", description: "Optional context note for agents" },
      },
      required: ["name", "target"],
    },
  },
  {
    name: "workflowy_search",
    description: "Full-text search across all nodes or a subtree",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        smart: { type: "boolean", description: "Enable AI reranking", default: false },
        live: { type: "boolean", description: "Search API directly", default: false },
        target: { type: "string", description: "Scope search to subtree" },
      },
      required: ["query"],
    },
  },
  {
    name: "search",
    description: "Full-text search across all nodes or a subtree (short alias of workflowy_search)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        smart: { type: "boolean", description: "Enable AI reranking", default: false },
        live: { type: "boolean", description: "Search API directly", default: false },
        target: { type: "string", description: "Scope search to subtree" },
      },
      required: ["query"],
    },
  },
  {
    name: "workflowy_move",
    description: "Move a node to a different parent",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID to move" },
        to: { type: "string", description: "Destination parent" },
        position: { type: "string", enum: ["top", "bottom"], default: "top" },
      },
      required: ["nodeId", "to"],
    },
  },
  {
    name: "move",
    description: "Move a node to a different parent (short alias of workflowy_move)",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID to move" },
        to: { type: "string", description: "Destination parent" },
        position: { type: "string", enum: ["top", "bottom"], default: "top" },
      },
      required: ["nodeId", "to"],
    },
  },
  {
    name: "workflowy_complete",
    description: "Mark a todo as complete or uncomplete",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID" },
        undo: { type: "boolean", description: "Uncheck instead", default: false },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "complete",
    description: "Mark a todo as complete or uncomplete (short alias of workflowy_complete)",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID" },
        undo: { type: "boolean", description: "Uncheck instead", default: false },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "workflowy_update",
    description: "Rename a node or edit its note",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID or cached path" },
        text: { type: "string", description: "Replacement node text" },
        note: { type: "string", description: "Replacement note text" },
        clearNote: { type: "boolean", description: "Remove the note", default: false },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "update",
    description: "Rename a node or edit its note (short alias of workflowy_update)",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID or cached path" },
        text: { type: "string", description: "Replacement node text" },
        note: { type: "string", description: "Replacement note text" },
        clearNote: { type: "boolean", description: "Remove the note", default: false },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "workflowy_batch",
    description: "Execute multiple operations in a batch. For markdown content, one add op may contain the entire multi-line markdown document in text; do not split it into one op per line unless you want separate nodes.",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "Array of operations. A single add op may include a full multi-line markdown document in text.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["capture", "add", "complete", "uncomplete", "move", "delete"],
                description: "Operation type.",
              },
              text: {
                type: "string",
                description: "Text for add/capture. This may be a full multi-line markdown document; it does not need to be split line by line.",
              },
              to: {
                type: "string",
                description: "Target parent for add/capture/move. Accepts @targets, paths, or node IDs.",
              },
              target: {
                type: "string",
                description: "Alternate target parent field. Accepts @targets, paths, or node IDs.",
              },
              ref: {
                type: "string",
                description: "Node ID for complete, uncomplete, move, or delete operations.",
              },
              type: {
                type: "string",
                enum: ["bullet", "todo", "h1", "h2", "h3"],
                description: "Optional node layout for add/capture.",
              },
              note: {
                type: "string",
                description: "Optional note content for add/capture.",
              },
              position: {
                type: "string",
                enum: ["top", "bottom"],
                description: "Optional insert/move position.",
              },
            },
            required: ["op"],
          },
        },
      },
      required: ["ops"],
    },
  },
  {
    name: "batch",
    description: "Execute multiple operations in a batch (short alias of workflowy_batch)",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "Array of operations. A single add op may include a full multi-line markdown document in text.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["capture", "add", "complete", "uncomplete", "move", "delete"],
                description: "Operation type.",
              },
              text: {
                type: "string",
                description: "Text for add/capture. This may be a full multi-line markdown document; it does not need to be split line by line.",
              },
              to: {
                type: "string",
                description: "Target parent for add/capture/move. Accepts @targets, paths, or node IDs.",
              },
              target: {
                type: "string",
                description: "Alternate target parent field. Accepts @targets, paths, or node IDs.",
              },
              ref: {
                type: "string",
                description: "Node ID for complete, uncomplete, move, or delete operations.",
              },
              type: {
                type: "string",
                enum: ["bullet", "todo", "h1", "h2", "h3"],
                description: "Optional node layout for add/capture.",
              },
              note: {
                type: "string",
                description: "Optional note content for add/capture.",
              },
              position: {
                type: "string",
                enum: ["top", "bottom"],
                description: "Optional insert/move position.",
              },
            },
            required: ["op"],
          },
        },
      },
      required: ["ops"],
    },
  },
  {
    name: "workflowy_propose",
    description: "Generate a structured diff via LLM",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "What changes to make" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "workflowy_context",
    description: "Show a node with ancestors, siblings, and children",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID or target" },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "context",
    description: "Show a node with ancestors, siblings, and children (short alias of workflowy_context)",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Node ID or target" },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "workflowy_sync",
    description: "Sync the local cache from WorkFlowy API",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync",
    description: "Sync the local cache from WorkFlowy API (short alias of workflowy_sync)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "status",
    description: "Show authentication, API, cache, and setup status",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const cmdMap: Record<string, string[]> = {
    workflowy_read: ["node:read", String(args.target ?? "@inbox"), ...(args.depth ? ["--depth", String(args.depth)] : []), ...(args.live ? ["--live"] : [])],
    read: ["node:read", String(args.target ?? "@inbox"), ...(args.depth ? ["--depth", String(args.depth)] : []), ...(args.live ? ["--live"] : [])],
    workflowy_add: ["node:add", String(args.to ?? "@inbox"), String(args.text ?? ""), ...(args.type ? ["--type", String(args.type)] : []), ...(args.note ? ["--note", String(args.note)] : [])],
    add: ["node:add", String(args.to ?? "@inbox"), String(args.text ?? ""), ...(args.type ? ["--type", String(args.type)] : []), ...(args.note ? ["--note", String(args.note)] : [])],
    workflowy_find: ["node:find", String(args.query ?? "")],
    find: ["node:find", String(args.query ?? "")],
    workflowy_todos: ["node:todos", ...(args.target ? ["--target", String(args.target)] : []), ...(args.completed ? ["--completed"] : []), ...(args.since ? ["--since", String(args.since)] : []), ...(args.limit ? ["--limit", String(args.limit)] : [])],
    workflowy_tags: ["tags", ...(args.target ? ["--target", String(args.target)] : []), ...(args.filter ? ["--filter", String(args.filter)] : [])],
    workflowy_targets: ["targets"],
    targets: ["targets"],
    list_bookmarks: ["bookmark:list", "--format", "json"],
    bookmarks: ["bookmark:list", "--format", "json"],
    save_bookmark: ["bookmark:save", String(args.name ?? ""), String(args.target ?? ""), ...(args.context ? ["--context", String(args.context)] : []), "--format", "json"],
    workflowy_search: ["search", String(args.query ?? ""), ...(args.smart ? ["--smart"] : []), ...(args.live ? ["--live"] : []), ...(args.target ? ["--target", String(args.target)] : [])],
    search: ["search", String(args.query ?? ""), ...(args.smart ? ["--smart"] : []), ...(args.live ? ["--live"] : []), ...(args.target ? ["--target", String(args.target)] : [])],
    workflowy_move: ["node:move", String(args.nodeId ?? ""), String(args.to ?? ""), ...(args.position ? ["--position", String(args.position)] : [])],
    move: ["node:move", String(args.nodeId ?? ""), String(args.to ?? ""), ...(args.position ? ["--position", String(args.position)] : [])],
    workflowy_complete: ["node:complete", String(args.nodeId ?? ""), ...(args.undo ? ["--undo"] : [])],
    complete: ["node:complete", String(args.nodeId ?? ""), ...(args.undo ? ["--undo"] : [])],
    workflowy_update: ["node:update", String(args.nodeId ?? ""), ...(args.text !== undefined ? ["--text", String(args.text)] : []), ...(args.note !== undefined ? ["--note", String(args.note)] : []), ...(args.clearNote ? ["--clear-note"] : [])],
    update: ["node:update", String(args.nodeId ?? ""), ...(args.text !== undefined ? ["--text", String(args.text)] : []), ...(args.note !== undefined ? ["--note", String(args.note)] : []), ...(args.clearNote ? ["--clear-note"] : [])],
    workflowy_batch: ["batch"],
    batch: ["batch"],
    workflowy_propose: ["ai:propose", String(args.instruction ?? "")],
    workflowy_context: ["node:context", String(args.nodeId ?? "")],
    context: ["node:context", String(args.nodeId ?? "")],
    workflowy_sync: ["cache:sync"],
    sync: ["cache:sync"],
    status: ["doctor"],
  };

  const cmdArgs = cmdMap[name];
  if (!cmdArgs) {
    return {
      text: JSON.stringify({ error: { code: "unknown_tool", message: `Unknown tool: ${name}` } }, null, 2),
      isError: true,
    };
  }

  const usesBatchStdin = name === "workflowy_batch" || name === "batch";

  const proc = Bun.spawn(getMcpCliInvocation(cmdArgs), {
    stdin: usesBatchStdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (usesBatchStdin) {
    const stdin = proc.stdin;
    if (!stdin) {
      return {
        text: JSON.stringify({
          error: {
            code: "tool_call_failed",
            message: "workflowy_batch could not open stdin for batch input",
            tool: name,
          },
        }, null, 2),
        isError: true,
      };
    }

    stdin.write(JSON.stringify(args.ops ?? []));
    stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (exitCode !== 0 && name !== "status") {
    return {
      text: trimmedStdout || JSON.stringify({
        error: {
          code: "tool_call_failed",
          message: trimmedStderr || `wf command failed with exit code ${exitCode}`,
          tool: name,
        },
      }, null, 2),
      isError: true,
    };
  }

  if (!trimmedStdout) {
    return {
      text: JSON.stringify({
        error: {
          code: "empty_tool_result",
          message: `wf returned no output for ${name}`,
          tool: name,
        },
      }, null, 2),
      isError: true,
    };
  }

  return {
    text: trimmedStdout,
    isError: false,
  };
}

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("Start as MCP server (stdio or HTTP/SSE transport)")
    .option("--port <n>", "HTTP/SSE port (e.g. 3399)")
    .option("--tools <list>", "Comma-separated list of tools to expose")
    .action(async (opts: { port?: string; tools?: string }) => {
      const allowedTools = opts.tools ? new Set(opts.tools.split(",").map((t) => t.trim())) : null;
      const tools = allowedTools
        ? MCP_TOOLS.filter((t) => allowedTools.has(t.name) || allowedTools.has(t.name.replace("workflowy_", "")) || (t.name === "list_bookmarks" && allowedTools.has("bookmarks")))
        : MCP_TOOLS;

      if (opts.port) {
        await startHttpSseServer(Number(opts.port), tools);
      } else {
        await startStdioServer(tools);
      }
    });
}

async function startStdioServer(tools: McpTool[]): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
    } else {
      buffer += decoder.decode(value, { stream: true });
    }

    const { messages, rest } = extractStdioMessages(buffer, done);
    buffer = rest;

    for (const message of messages) {
      const response = await safelyHandleMcpMessage(message.payload, tools);
      if (!response) continue;

      const responseStr = JSON.stringify(response);
      if (message.format === "content-length") {
        const responseBytes = new TextEncoder().encode(responseStr);
        process.stdout.write(`Content-Length: ${responseBytes.length}\r\n\r\n${responseStr}`);
      } else {
        process.stdout.write(`${responseStr}\n`);
      }
    }

    if (done) {
      break;
    }
  }
}

type StdioMessage = {
  format: "content-length" | "line";
  payload: Record<string, unknown>;
};

function extractStdioMessages(
  input: string,
  flushFinalLine: boolean,
): { messages: StdioMessage[]; rest: string } {
  const messages: StdioMessage[] = [];
  let buffer = input;

  while (true) {
    const stripped = buffer.replace(/^\r?\n+/, "");
    if (stripped !== buffer) {
      buffer = stripped;
    }

    const framed = extractContentLengthMessage(buffer);
    if (framed.kind === "message") {
      buffer = framed.rest;
      try {
        const payload = JSON.parse(framed.body) as Record<string, unknown>;
        messages.push({ format: "content-length", payload });
      } catch {
        // Skip malformed payloads and continue parsing the stream.
      }
      continue;
    }

    if (framed.kind === "incomplete") {
      break;
    }

    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      if (!flushFinalLine) break;
      const line = buffer.trim();
      buffer = "";
      if (!line) break;

      try {
        const payload = JSON.parse(line) as Record<string, unknown>;
        messages.push({ format: "line", payload });
      } catch {
        // Ignore trailing malformed input.
      }
      break;
    }

    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (!line) {
      continue;
    }

    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      messages.push({ format: "line", payload });
    } catch {
      // Ignore malformed line-delimited payloads.
    }
  }

  return { messages, rest: buffer };
}

function extractContentLengthMessage(input: string):
  | { kind: "message"; body: string; rest: string }
  | { kind: "incomplete" }
  | { kind: "none" } {
  const crlfHeaderEnd = input.indexOf("\r\n\r\n");
  const lfHeaderEnd = input.indexOf("\n\n");
  const headerEnd = crlfHeaderEnd !== -1
    ? { index: crlfHeaderEnd, delimiterLength: 4 }
    : lfHeaderEnd !== -1
      ? { index: lfHeaderEnd, delimiterLength: 2 }
      : null;

  if (!headerEnd) {
    if (/^Content-Length:/i.test(input)) {
      return { kind: "incomplete" };
    }
    return { kind: "none" };
  }

  const header = input.slice(0, headerEnd.index);
  if (!/^Content-Length:/im.test(header)) {
    return { kind: "none" };
  }

  const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
  if (!lengthMatch) {
    return { kind: "none" };
  }

  const contentLength = Number(lengthMatch[1]);
  const bodyStart = headerEnd.index + headerEnd.delimiterLength;
  if (input.length < bodyStart + contentLength) {
    return { kind: "incomplete" };
  }

  return {
    kind: "message",
    body: input.slice(bodyStart, bodyStart + contentLength),
    rest: input.slice(bodyStart + contentLength),
  };
}

async function startHttpSseServer(port: number, tools: McpTool[]): Promise<void> {
  const sessions = new Map<string, ReadableStreamDefaultController>();

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/sse" && req.method === "GET") {
        const sessionId = crypto.randomUUID();
        const stream = new ReadableStream({
          start(controller) {
            sessions.set(sessionId, controller);
            const endpoint = `http://localhost:${port}/message?sessionId=${sessionId}`;
            controller.enqueue(`event: endpoint\ndata: ${endpoint}\n\n`);
          },
          cancel() {
            sessions.delete(sessionId);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/message" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId || !sessions.has(sessionId)) {
          return new Response(JSON.stringify({ error: "Invalid session" }), { status: 400 });
        }

        const controller = sessions.get(sessionId)!;
        const body = await req.json() as Record<string, unknown>;
        const response = await safelyHandleMcpMessage(body, tools);

        if (response) {
          const responseStr = JSON.stringify(response);
          controller.enqueue(`event: message\ndata: ${responseStr}\n\n`);
        }

        return new Response("accepted", { status: 202 });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  if (!isAgentMode()) {
    console.log(chalk.green(`\n  MCP HTTP/SSE server listening on port ${port}`));
    console.log(chalk.dim(`  SSE endpoint: http://localhost:${port}/sse`));
    console.log(chalk.dim(`  Message endpoint: http://localhost:${port}/message?sessionId=<id>\n`));
  }

  // Keep the process alive
  await new Promise(() => {});
}

async function handleMcpMessage(msg: Record<string, unknown>, tools: McpTool[]): Promise<Record<string, unknown> | null> {
  const method = msg.method as string;
  const id = msg.id;

  if (method === "initialize") {
    await ensureMcpCacheReadyForInitialize();
    const instructions = getInitializeInstructions();

    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "workflowy", version: "3.0.6" },
        instructions,
      },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const params = msg.params;
    if (!params || typeof params !== "object") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid params: tools/call requires a params object" },
      };
    }

    const toolParams = params as { name?: unknown; arguments?: unknown };
    if (typeof toolParams.name !== "string" || toolParams.name.length === 0) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid params: tools/call requires a tool name" },
      };
    }

    const args = toolParams.arguments && typeof toolParams.arguments === "object"
      ? toolParams.arguments as Record<string, unknown>
      : {};
    const toolName = toolParams.name;

    const result = await handleToolCall(toolName, args);

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: result.text }],
        isError: result.isError ?? false,
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

async function safelyHandleMcpMessage(
  msg: Record<string, unknown>,
  tools: McpTool[],
): Promise<Record<string, unknown> | null> {
  try {
    return await handleMcpMessage(msg, tools);
  } catch (error) {
    const id = msg.id ?? null;
    const message = error instanceof Error ? error.message : String(error);

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: `Internal error: ${message}`,
      },
    };
  }
}
