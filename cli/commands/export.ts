import type { Command } from "commander";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { parseLlmDocResponse, type FlatNode } from "../shared/nodes.ts";
import { formatOutline } from "../output/compact.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";
import { resolveTargetReference } from "../shared/path.ts";
import { getCacheNodeCount } from "../shared/cache.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerExport(program: Command): void {
  program
    .command("node:export <target>")
    .description("Export a subtree to stdout")
    .option("--depth <n>", "Max depth", parseInt)
    .option(
      "--format <type>",
      "Output format (outline|json|markdown)",
      "outline"
    )
    .option("--copy", "Copy output to clipboard")
    .action(
      async (
        target: string,
        opts: { depth?: number; format: string; copy?: boolean }
      ) => {
        if (opts.copy) startOutputCapture();

        const token = requireToken();
        const api = new WorkflowyAPI(token);
        if (target.startsWith("@") && target.includes("/") && getCacheNodeCount() === 0) {
          exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first for path-based exports.");
        }
        const resolved = resolveTargetReference(target);
        if (!resolved) {
          exitWithError("node_not_found", `Target "${target}" could not be resolved`, "Run `wf cache:sync` to refresh path lookups");
        }
        const depth = opts.depth ?? 5;

        const data = await api.readDoc(resolved.id, depth);
        const { node } = parseLlmDocResponse(data);

        const format = isAgentMode() ? "json" : opts.format;

        switch (format) {
          case "json": {
            const config = loadConfig();
            console.log(
              formatJson({
                meta: {
                  command: "node:export",
                  target,
                  resolved_id: resolved.id,
                  timestamp: new Date().toISOString(),
                  account: config.activeAccount,
                  wf_version: "3.0.6",
                },
              node: {
                id: node.id,
                name: node.name,
                note: node.note,
                type: node.type,
                completed: node.completed,
                hasMore: false,
                children: [],
              },
                children: node.children,
              })
            );
            break;
          }

          case "markdown":
            console.log(toMarkdown(node, opts.depth));
            break;

          default:
            console.log(formatOutline(node, opts.depth));
            break;
        }

        await handleCopyFlag(!!opts.copy);
      }
    );
}

function toMarkdown(
  node: FlatNode,
  maxDepth?: number,
  depth = 0
): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  if (depth === 0) {
    lines.push(`# ${node.name}`);
    if (node.note) lines.push(`\n${node.note}`);
    lines.push("");
  } else {
    const checkbox =
      node.type === "todo"
        ? node.completed
          ? "[x] "
          : "[ ] "
        : "";
    lines.push(`${indent}- ${checkbox}${node.name}`);
    if (node.note) {
      lines.push(`${indent}  > ${node.note}`);
    }
  }

  if (maxDepth === undefined || depth < maxDepth) {
    for (const child of node.children) {
      lines.push(toMarkdown(child, maxDepth, depth + 1));
    }
  } else if (node.hasMore) {
    lines.push(`${indent}  ${depth === 0 ? "" : "  "}...`);
  }

  return lines.join("\n");
}
