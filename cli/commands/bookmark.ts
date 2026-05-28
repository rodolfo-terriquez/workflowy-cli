import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../shared/config.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { buildBreadcrumb, getNodeById } from "../shared/cache.ts";
import { listBookmarks, normalizeBookmarkName, saveBookmark } from "../shared/db.ts";
import { resolveCacheTargetReference, resolveTargetReference } from "../shared/path.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { exitWithError } from "../shared/errors.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";

export function registerBookmarkCommands(program: Command): void {
  program
    .command("bookmark:list")
    .alias("bookmarks")
    .description("List saved local bookmarks")
    .option("--format <type>", "Output format (outline|json)")
    .option("--copy", "Copy output to clipboard")
    .action(async (opts: { format?: string; copy?: boolean }) => {
      if (opts.copy) startOutputCapture();

      const config = loadConfig();
      const bookmarks = listBookmarks(config.activeAccount);
      const useJson = opts.format === "json" || isAgentMode();

      const rows = bookmarks.map((bookmark) => {
        const node = getNodeById(bookmark.nodeId);
        const path = node ? buildBreadcrumb(bookmark.nodeId).join(" > ") : null;

        return {
          name: bookmark.name,
          node_id: bookmark.nodeId,
          context: bookmark.context,
          created_at: bookmark.createdAt,
          updated_at: bookmark.updatedAt,
          node_name: node ? cleanHtml(node.name) : null,
          path,
        };
      });

      if (useJson) {
        console.log(formatJson({
          meta: {
            command: "bookmark:list",
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.0.6",
          },
          bookmarks: rows,
        }));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      if (rows.length === 0) {
        console.log(chalk.dim("\n  No bookmarks saved.\n"));
        await handleCopyFlag(!!opts.copy);
        return;
      }

      console.log("\n  Bookmarks:\n");
      for (const bookmark of rows) {
        console.log(`  ${chalk.cyan(`@${bookmark.name}`.padEnd(20))} ${chalk.dim(bookmark.node_id)}`);
        if (bookmark.node_name) console.log(`  ${chalk.dim("Node:")} ${bookmark.node_name}`);
        if (bookmark.path) console.log(`  ${chalk.dim("Path:")} ${chalk.dim(bookmark.path)}`);
        if (bookmark.context) console.log(`  ${chalk.dim("Note:")} ${bookmark.context}`);
        console.log("");
      }

      await handleCopyFlag(!!opts.copy);
    });

  program
    .command("bookmark:save <name> <target>")
    .description("Save a local bookmark pointing at a node")
    .option("--context <text>", "Optional context note for agents")
    .option("--format <type>", "Output format (outline|json)")
    .action((name: string, target: string, opts: { context?: string; format?: string }) => {
      const config = loadConfig();
      const resolved = resolveCacheTargetReference(target) ?? resolveTargetReference(target);

      if (!resolved) {
        exitWithError("node_not_found", `Target "${target}" not found`, "Run `wf cache:sync` to refresh path lookups");
      }

      const bookmark = saveBookmark(config.activeAccount, {
        name,
        nodeId: resolved.id,
        context: opts.context ?? null,
      });

      const node = getNodeById(bookmark.nodeId);
      const path = node ? buildBreadcrumb(bookmark.nodeId).join(" > ") : null;
      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(formatJson({
          meta: {
            command: "bookmark:save",
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.0.6",
          },
          bookmark: {
            name: bookmark.name,
            node_id: bookmark.nodeId,
            context: bookmark.context,
            created_at: bookmark.createdAt,
            updated_at: bookmark.updatedAt,
            node_name: node ? cleanHtml(node.name) : null,
            path,
          },
        }));
        return;
      }

      console.log(`\n  ${chalk.green("✓")} Saved ${chalk.cyan(`@${normalizeBookmarkName(name)}`)} → ${chalk.dim(bookmark.nodeId)}\n`);
    });
}
