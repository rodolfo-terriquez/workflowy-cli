import type { Command } from "commander";
import chalk from "chalk";
import { isAgentMode } from "../agent.ts";
import { loadConfig } from "../shared/config.ts";
import { getCacheAgeSeconds, getCacheNodeCount } from "../shared/cache.ts";
import { getConfiguredMcpInstructions, getConfiguredMcpInstructionsTarget, resolveConfiguredMcpInstructionsNode } from "../shared/mcp-instructions.ts";
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

interface McpToolInvocation {
  name: string;
  args: Record<string, unknown>;
  cmdArgs: string[];
  usesBatchStdin: boolean;
}

interface CliExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CliErrorPayload {
  error?: {
    code?: string;
    message?: string;
    hint?: string;
  };
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
5. Use \`workflowy_batch\` for grouped common changes. Markdown-style text in \`text\` is converted to Workflowy rich text, including common inline formatting and leading markers like \`##\` or \`[ ]\`.
6. Use \`edit_doc\` only when you need advanced structured edits such as nested inserts, insert-after, richer line types, layout changes, or old local-MCP-style raw operations.
7. Under normal conditions the MCP server auto-refreshes the local cache when it is empty, stale, or a cache-backed lookup appears out of date. Use \`sync\` only if that automatic refresh fails or you need to force it.
8. If the user shares a WorkFlowy link, extract the hex ID after \`#/\` and use that as the node ID.

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
- To perform advanced raw structured edits: use \`edit_doc\`.

## Common Mistakes to Avoid

- Do not assume you need to manage cache refreshes manually; the MCP server usually does that for you. Use \`sync\` when automatic refresh fails or you need to force a full refresh.
- Do not search for or create date nodes by plain text when a built-in calendar target such as \`@today\`, \`@tomorrow\`, \`@calendar\`, or \`@next-week\` will do.
- Do not guess between ambiguous matches; ask or disambiguate.
- Do not split one logical item into many add operations unless you want separate nodes.
- Do not use raw node IDs when a stable target or cached path is available.
- Do not make multiple write calls when one batch call will do.

## Tips

- \`status\` helps you detect auth, API, and cache issues before other tool calls.
- Cache refresh is normally automatic in MCP sessions; \`sync\` remains available as a manual fallback.
- \`workflowy_targets\` helps you learn what the account exposes.
- \`bookmarks\` may include bookmark context notes that help with navigation.
- For date-related work, prefer built-in calendar targets such as \`@today\`, \`@tomorrow\`, \`@calendar\`, and \`@next-week\` instead of searching for date nodes by text.
- To create a clickable date chip in node text or notes, use a literal time tag such as \`<time startYear="2026" startMonth="6" startDay="3">Jun 3, 2026</time>\`. \`startYear\` must be 4 digits; \`startMonth\` and \`startDay\` must not use leading zeroes. Plain-text dates will not render as chips.
- \`workflowy_context\` is often better than a deep read when you need nearby siblings and ancestors.
- Use smaller reads first, then expand depth only if needed.`;

const MCP_SOFT_STALE_SECONDS = 300;
const MCP_HARD_STALE_SECONDS = 1800;
const MCP_AUTO_SYNC_COOLDOWN_MS = 5 * 60_000;
const DIRECT_ID_RE = /^[0-9a-f]{8,}(-[0-9a-f]{4,}){0,4}$/i;

let mcpAutoSyncPromise: Promise<{ ok: boolean; error?: string; reason: string }> | null = null;
let mcpAutoSyncStartedAt = 0;

function getInitializeInstructions(maxDepth = 4): string {
  const parts = [DEFAULT_MCP_INSTRUCTIONS];
  const userInstructions = getUserInitializeInstructions(maxDepth);

  if (userInstructions) {
    parts.push(`## User custom instructions\n\n${userInstructions}`);
  }

  return parts.join("\n\n").trim();
}

function getUserInitializeInstructions(maxDepth = 4): string | null {
  return getConfiguredMcpInstructions(maxDepth);
}

function getMcpSoftStaleReason(): "stale" | null {
  const age = getCacheAgeSeconds();
  if (age === null) return null;
  return age > MCP_SOFT_STALE_SECONDS ? "stale" : null;
}

export function getMcpInitializeSyncReason(): "cache_empty" | "instructions_unresolved" | "hard_stale" | null {
  if (getCacheNodeCount() === 0) {
    return "cache_empty";
  }

  const configured = getConfiguredMcpInstructionsTarget();
  if (configured && !resolveConfiguredMcpInstructionsNode()) {
    return "instructions_unresolved";
  }

  const age = getCacheAgeSeconds();
  if (age !== null && age > MCP_HARD_STALE_SECONDS) {
    return "hard_stale";
  }

  return null;
}

export async function ensureMcpCacheReadyForInitialize(
  syncFn: (opts?: { silent?: boolean }) => Promise<unknown> = doSync,
): Promise<boolean> {
  const blockingReason = getMcpInitializeSyncReason();
  if (blockingReason) {
    await requestMcpAutoSync(blockingReason, { blocking: true, force: true, syncFn });
    return true;
  }

  if (getMcpSoftStaleReason()) {
    void requestMcpAutoSync("stale_initialize", { blocking: false, syncFn });
    return true;
  }

  return false;
}

async function requestMcpAutoSync(
  reason: string,
  opts: {
    blocking: boolean;
    force?: boolean;
    syncFn?: (options?: { silent?: boolean }) => Promise<unknown>;
  },
): Promise<{ attempted: boolean; ok: boolean; shared: boolean; skipped?: "cooldown"; error?: string; reason: string }> {
  const syncFn = opts.syncFn ?? doSync;

  if (mcpAutoSyncPromise) {
    if (opts.blocking) {
      const result = await mcpAutoSyncPromise;
      return { attempted: true, ok: result.ok, shared: true, error: result.error, reason: result.reason };
    }
    return { attempted: true, ok: true, shared: true, reason };
  }

  const now = Date.now();
  if (!opts.force && now - mcpAutoSyncStartedAt < MCP_AUTO_SYNC_COOLDOWN_MS) {
    return { attempted: false, ok: false, shared: false, skipped: "cooldown", reason };
  }

  mcpAutoSyncStartedAt = now;
  mcpAutoSyncPromise = (async () => {
    try {
      await syncFn({ silent: true });
      return { ok: true, reason };
    } catch (error) {
      return {
        ok: false,
        reason,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      mcpAutoSyncPromise = null;
    }
  })();

  if (opts.blocking) {
    const result = await mcpAutoSyncPromise;
    return { attempted: true, ok: result.ok, shared: false, error: result.error, reason: result.reason };
  }

  void mcpAutoSyncPromise;
  return { attempted: true, ok: true, shared: false, reason };
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
    description: "START EVERY CONVERSATION HERE when you need saved Workflowy locations or user guidance. Returns saved local bookmarks, their target nodes, and any configured custom MCP instructions. Use bookmark node IDs or @bookmark targets directly before searching.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "bookmarks",
    description: "Short alias of list_bookmarks. START EVERY CONVERSATION HERE when you need saved Workflowy locations or user guidance. Returns saved local bookmarks, their target nodes, and any configured custom MCP instructions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "save_bookmark",
    description: "Save or update a local bookmark for a WorkFlowy node. Use the context field to leave future agents a concise note about what this location contains and how it should be used.",
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
    name: "edit_doc",
    description: "Advanced structured document edit. This is the parity escape hatch for agents that need old local-MCP-style operations: nested inserts, insert-after, richer line types, updates, moves, and deletes.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          description: "The subtree root: @target, path, node ID, or cached target. Operations are applied relative to this root.",
        },
        operations: {
          type: "array",
          description: "Array of structured edit operations. Supports insert/update/delete/move with nested item trees.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["insert", "update", "delete", "move"] },
              under: { type: "string", description: "For insert/move: parent target or node ID." },
              after: { type: "string", description: "For insert: sibling node ID/target to insert after." },
              items: {
                type: "array",
                description: "For insert: nodes to create. Children can be nested with c.",
                items: {
                  type: "object",
                  properties: {
                    n: { type: "string", description: "Node text" },
                    d: { type: "string", description: "Optional note" },
                    l: { type: "string", enum: ["todo", "h1", "h2", "h3", "p", "bullets", "code", "quote", "table"], description: "Line/layout type" },
                    x: { type: "number", enum: [0, 1], description: "Completion status (1 = complete)" },
                    c: { type: "array", description: "Nested child items" },
                  },
                  required: ["n"],
                },
              },
              position: { type: "string", enum: ["top", "bottom"], description: "For insert/move: target position" },
              ref: { type: "string", description: "For update/delete/move: node ID or cached path" },
              to: {
                type: "object",
                description: "For update: replacement fields",
                properties: {
                  n: { type: "string", description: "New node text" },
                  d: { type: "string", description: "New note" },
                  l: { type: "string", enum: ["todo", "h1", "h2", "h3", "p", "bullets", "code", "quote", "table"], description: "New line/layout type" },
                  x: { type: "number", enum: [0, 1], description: "Completion status" },
                  c: { type: "array", description: "Nested children if supported by the API" },
                },
              },
            },
            required: ["op"],
          },
        },
      },
      required: ["root", "operations"],
    },
  },
  {
    name: "workflowy_edit_doc",
    description: "Alias of edit_doc for advanced structured document edits.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "The subtree root: @target, path, node ID, or cached target." },
        operations: { type: "array", description: "Array of structured edit operations." },
      },
      required: ["root", "operations"],
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
    description: "Execute multiple operations in a batch. Markdown-style text is converted to Workflowy rich text on write; do not split one logical item into one op per line unless you want separate nodes.",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "Array of operations. Add text can use Markdown-style formatting that will be converted on write.",
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
                description: "Text for add/capture. Common Markdown-style formatting is converted to Workflowy rich text on write.",
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
          description: "Array of operations. Add text can use Markdown-style formatting that will be converted on write.",
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
                description: "Text for add/capture. Common Markdown-style formatting is converted to Workflowy rich text on write.",
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

function buildToolInvocation(name: string, args: Record<string, unknown>): McpToolInvocation | null {
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
    edit_doc: ["doc:edit", String(args.root ?? "")],
    workflowy_edit_doc: ["doc:edit", String(args.root ?? "")],
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
  if (!cmdArgs) return null;

  return {
    name,
    args,
    cmdArgs,
    usesBatchStdin: name === "workflowy_batch" || name === "batch" || name === "edit_doc" || name === "workflowy_edit_doc",
  };
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const invocation = buildToolInvocation(name, args);
  if (!invocation) {
    return {
      text: JSON.stringify({ error: { code: "unknown_tool", message: `Unknown tool: ${name}` } }, null, 2),
      isError: true,
    };
  }

  await maybePreflightAutoSync(invocation);

  const initialResult = await executeToolInvocation(invocation);
  const recoveredResult = await maybeRecoverToolCall(invocation, initialResult);
  const finalResult = recoveredResult ?? initialResult;
  const finalStdout = finalResult.stdout.trim();
  const finalStderr = finalResult.stderr.trim();

  if (finalResult.exitCode !== 0 && name !== "status") {
    return {
      text: finalStdout || JSON.stringify({
        error: {
          code: "tool_call_failed",
          message: finalStderr || `wf command failed with exit code ${finalResult.exitCode}`,
          tool: name,
        },
      }, null, 2),
      isError: true,
    };
  }

  if (!finalStdout) {
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
    text: finalStdout,
    isError: false,
  };
}

async function executeToolInvocation(invocation: McpToolInvocation): Promise<CliExecutionResult> {
  const proc = Bun.spawn(getMcpCliInvocation(invocation.cmdArgs), {
    stdin: invocation.usesBatchStdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (invocation.usesBatchStdin) {
    const stdin = proc.stdin;
    if (!stdin) {
      return {
        stdout: JSON.stringify({
          error: {
            code: "tool_call_failed",
            message: "workflowy_batch could not open stdin for batch input",
            tool: invocation.name,
          },
        }, null, 2),
        stderr: "",
        exitCode: 1,
      };
    }

    stdin.write(JSON.stringify(invocation.args.ops ?? invocation.args.operations ?? []));
    stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function maybePreflightAutoSync(invocation: McpToolInvocation): Promise<void> {
  if (!shouldPreflightCheckCache(invocation)) return;

  const blockingReason = getMcpInitializeSyncReason();
  if (blockingReason) {
    await requestMcpAutoSync(`tool_preflight:${blockingReason}`, { blocking: true, force: true });
    return;
  }

  if (getMcpSoftStaleReason()) {
    void requestMcpAutoSync(`tool_preflight:stale:${invocation.name}`, { blocking: false });
  }
}

async function maybeRecoverToolCall(
  invocation: McpToolInvocation,
  result: CliExecutionResult,
): Promise<CliExecutionResult | null> {
  if (result.exitCode === 0 || invocation.name === "status") {
    return null;
  }

  const parsedError = parseCliError(result.stdout);
  if (!parsedError?.error?.code) {
    return null;
  }

  if (shouldUseLiveReadFallback(invocation, parsedError)) {
    const liveResult = await executeToolInvocation({
      ...invocation,
      cmdArgs: withLiveReadFlag(invocation.cmdArgs),
    });

    if (liveResult.exitCode === 0 && liveResult.stdout.trim()) {
      const liveSyncAttempt = await requestMcpAutoSync(`tool_recovery:live:${invocation.name}`, { blocking: false });
      return annotateCliExecutionResult(liveResult, {
        fallback: "live_read",
        auto_sync: {
          status: liveSyncAttempt.attempted ? "scheduled" : liveSyncAttempt.skipped === "cooldown" ? "skipped_cooldown" : "shared",
          reason: liveSyncAttempt.reason,
        },
      });
    }
  }

  if (!shouldRetryAfterSync(invocation, parsedError)) {
    return null;
  }

  const syncAttempt = await requestMcpAutoSync(`tool_recovery:${invocation.name}`, { blocking: true });
  if (!syncAttempt.attempted || !syncAttempt.ok) {
    return annotateCliExecutionResult(result, {
      auto_sync: {
        status: syncAttempt.skipped === "cooldown" ? "skipped_cooldown" : "failed",
        reason: syncAttempt.reason,
        error: syncAttempt.error,
      },
    });
  }

  const retried = await executeToolInvocation(invocation);
  return annotateCliExecutionResult(retried, {
    auto_sync: {
      status: "retried",
      reason: syncAttempt.reason,
      shared: syncAttempt.shared,
    },
  });
}

function shouldPreflightCheckCache(invocation: McpToolInvocation): boolean {
  if (["workflowy_sync", "sync", "status"].includes(invocation.name)) {
    return false;
  }

  if ((invocation.name === "workflowy_read" || invocation.name === "read") && invocation.args.live) {
    return false;
  }

  if ((invocation.name === "workflowy_search" || invocation.name === "search") && invocation.args.live) {
    return false;
  }

  return true;
}

function shouldUseLiveReadFallback(invocation: McpToolInvocation, payload: CliErrorPayload): boolean {
  if (!["workflowy_read", "read"].includes(invocation.name)) return false;
  if (invocation.args.live) return false;
  if (payload.error?.code !== "node_not_found") return false;

  const target = String(invocation.args.target ?? "@inbox");
  return looksLikeDirectId(target);
}

function shouldRetryAfterSync(invocation: McpToolInvocation, payload: CliErrorPayload): boolean {
  const code = payload.error?.code;
  if (!code) return false;

  if (code === "cache_empty") return true;
  if (code !== "node_not_found") return false;

  switch (invocation.name) {
    case "workflowy_read":
    case "read":
      return !invocation.args.live && isLikelyStaleLookup(String(invocation.args.target ?? "@inbox"));
    case "workflowy_context":
    case "context":
    case "workflowy_update":
    case "update":
    case "workflowy_complete":
    case "complete":
      return isLikelyStaleLookup(String(invocation.args.nodeId ?? ""));
    case "workflowy_move":
    case "move":
      return isLikelyStaleLookup(String(invocation.args.nodeId ?? "")) || isLikelyStaleLookup(String(invocation.args.to ?? ""));
    case "workflowy_add":
    case "add":
      return isLikelyStaleLookup(String(invocation.args.to ?? "@inbox"));
    case "save_bookmark":
      return isLikelyStaleLookup(String(invocation.args.target ?? ""));
    case "workflowy_search":
    case "search":
      return !!invocation.args.target && isLikelyStaleLookup(String(invocation.args.target));
    default:
      return false;
  }
}

function isLikelyStaleLookup(input: string): boolean {
  if (!input) return false;
  if (input.startsWith("@")) return true;
  if (looksLikeDirectId(input)) return true;
  return input.includes("/");
}

function looksLikeDirectId(input: string): boolean {
  return DIRECT_ID_RE.test(input);
}

function withLiveReadFlag(cmdArgs: string[]): string[] {
  return cmdArgs.includes("--live") ? [...cmdArgs] : [...cmdArgs, "--live"];
}

function parseCliError(stdout: string): CliErrorPayload | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;

  try {
    return JSON.parse(trimmed) as CliErrorPayload;
  } catch {
    return null;
  }
}

function annotateCliExecutionResult(
  result: CliExecutionResult,
  metadata: Record<string, unknown>,
): CliExecutionResult {
  const trimmed = result.stdout.trim();
  if (!trimmed.startsWith("{")) {
    return result;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    parsed._mcp = {
      ...(typeof parsed._mcp === "object" && parsed._mcp ? parsed._mcp as Record<string, unknown> : {}),
      ...metadata,
    };
    return {
      ...result,
      stdout: JSON.stringify(parsed, null, 2),
    };
  } catch {
    return result;
  }
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
        serverInfo: { name: "workflowy", version: "3.1.0" },
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
