import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { getCacheNodeCount, getCacheAgeSeconds, getNodeById, isCacheStale, markTargetDirty } from "../shared/cache.ts";
import { findByNameOrPath, isDirectId } from "../shared/path.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerNodeUpdate(program: Command): void {
  program
    .command("node:update <nodeIdOrPath>")
    .description("Rename a node or edit its note")
    .option("--text <text>", "Replace the node text")
    .option("--note <note>", "Replace the node note")
    .option("--clear-note", "Remove the node note")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        nodeIdOrPath: string,
        opts: { text?: string; note?: string; clearNote?: boolean; format?: string }
      ) => {
        if (!opts.text && opts.note === undefined && !opts.clearNote) {
          exitWithError("missing_arg", "Provide at least one change with --text, --note, or --clear-note");
        }

        if (opts.note !== undefined && opts.clearNote) {
          exitWithError("invalid_args", "Use either --note or --clear-note, not both");
        }

        const token = requireToken();
        const api = new WorkflowyAPI(token);
        const nodeId = resolveNodeArg(nodeIdOrPath);

        const to: { n?: string; d?: string } = {};
        if (opts.text !== undefined) to.n = opts.text;
        if (opts.clearNote) {
          to.d = "";
        } else if (opts.note !== undefined) {
          to.d = opts.note;
        }

        await api.readDoc(nodeId, 1);
        await api.editDoc(nodeId, [{ op: "update", ref: nodeId, to }]);

        const cached = getCacheNodeCount() > 0 ? getNodeById(nodeId) : null;
        markTargetDirty(nodeId);
        if (cached?.parent_id) {
          markTargetDirty(cached.parent_id);
        }

        const useJson = opts.format === "json" || isAgentMode();
        const changedFields = [
          opts.text !== undefined ? "text" : null,
          opts.note !== undefined || opts.clearNote ? "note" : null,
        ].filter(Boolean) as string[];

        if (useJson) {
          const config = loadConfig();
          const meta: Record<string, unknown> = {
            command: "node:update",
            target: nodeIdOrPath,
            resolved_id: nodeId,
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.0.2",
          };
          const cacheAge = getCacheAgeSeconds();
          if (cacheAge !== null) {
            meta.cache_age_seconds = cacheAge;
            meta.cache_stale = isCacheStale();
          }
          console.log(formatJson({ meta, message: `Updated ${changedFields.join(" and ")} on ${nodeId}` }));
        } else {
          console.log(`\n  ${chalk.green("✓")} Updated ${changedFields.join(" and ")} on ${chalk.dim(nodeId)}\n`);
        }
      }
    );
}

function resolveNodeArg(input: string): string {
  if (isDirectId(input)) return input;

  if (getCacheNodeCount() > 0) {
    const matches = findByNameOrPath(input);
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      exitWithError(
        "ambiguous_target",
        `"${input}" matches ${matches.length} nodes`,
        `Use a node ID. Candidates: ${matches.slice(0, 3).map((m) => m.id).join(", ")}`
      );
    }
  }

  exitWithError("node_not_found", `Node "${input}" not found`, "Use a hex node ID or run `wf cache:sync` first for path resolution");
}
