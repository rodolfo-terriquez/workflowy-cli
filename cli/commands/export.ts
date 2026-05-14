import type { Command } from "commander";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { parseLlmDocResponse, type FlatNode } from "../shared/nodes.ts";
import { resolveTarget } from "../targets.ts";
import { formatOutline } from "../output/compact.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerExport(program: Command): void {
  program
    .command("export <target>")
    .description("Export a subtree to stdout")
    .option("--depth <n>", "Max depth", parseInt)
    .option(
      "--format <type>",
      "Output format (outline|json|markdown)",
      "outline"
    )
    .action(
      async (
        target: string,
        opts: { depth?: number; format: string }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);
        const resolved = resolveTarget(target);
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
                  command: "export",
                  target,
                  resolved_id: resolved.id,
                  timestamp: new Date().toISOString(),
                  account: config.activeAccount,
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
