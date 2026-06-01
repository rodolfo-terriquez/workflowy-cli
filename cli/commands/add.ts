import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken } from "../shared/config.ts";
import { getCacheNodeCount, markTargetDirty } from "../shared/cache.ts";
import { resolveTargetReference } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { buildWriteSuccessOutput } from "../shared/write-response.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerNodeAdd(program: Command): void {
  program
    .command("node:add <target> <text>")
    .description("Add a child node to a target")
    .option("--type <type>", "Node layout (bullet|todo|h1|h2|h3)", "bullet")
    .option("--note <note>", "Note content for the node")
    .option("--position <pos>", "Position: top or bottom", "bottom")
    .option("--after <nodeId>", "Insert after this sibling node")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        target: string,
        text: string,
        opts: {
          type: string;
          note?: string;
          position: string;
          after?: string;
          format?: string;
        }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);

        let resolvedId: string;
        let resolvedLabel: string;

        if (target.startsWith("@") && target.includes("/") && getCacheNodeCount() === 0) {
          exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first for path-based targets.");
        }

        const resolved = resolveTargetReference(target);
        if (!resolved) {
          exitWithError("node_not_found", `Target "${target}" could not be resolved`, "Run `wf cache:sync` to refresh path lookups");
        }

        resolvedId = resolved.id;
        resolvedLabel = resolved.label;

        const item: { n: string; d?: string; l?: string } = { n: text };
        if (opts.note) item.d = opts.note;
        if (opts.type !== "bullet") item.l = opts.type;

        if (opts.after) {
          await api.editDoc(resolvedId, [
            { op: "insert", after: opts.after, items: [item] },
          ]);
        } else {
          await api.editDoc(resolvedId, [
            { op: "insert", under: resolvedId, items: [item], position: opts.position as "top" | "bottom" },
          ]);
        }

        markTargetDirty(resolvedId);
        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          console.log(formatJson(buildWriteSuccessOutput({
            command: "node:add",
            target,
            resolvedId,
            message: `Added to ${resolvedLabel}`,
            affectedNodeIds: [resolvedId],
            dirtyNodeIds: [resolvedId],
            details: {
              parent_id: resolvedId,
              insert_after_id: opts.after,
              requested_node: {
                text,
                note: opts.note,
                type: opts.type,
                position: opts.after ? undefined : opts.position,
              },
            },
          })));
        } else {
          console.log(
            `\n  ${chalk.green("✓")} Added to ${chalk.cyan(resolvedLabel)}: ${text}\n`
          );
        }
      }
    );
}
