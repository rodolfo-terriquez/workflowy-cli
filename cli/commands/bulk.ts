import type { Command } from "commander";
import chalk from "chalk";
import { getCacheDb, getCacheNodeCount, getSubtreeIds, buildBreadcrumbDisplay, markTargetDirty, type CachedNode } from "../shared/cache.ts";
import { WorkflowyAPI, type LlmDocOperation } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import { resolveCacheTargetReference, resolveTargetReference } from "../shared/path.ts";

function parseSince(s: string): number {
  const match = s.match(/^(\d+)(m|h|d)$/);
  if (!match) return 30 * 60 * 1000;
  const n = Number(match[1]);
  switch (match[2]) {
    case "m": return n * 60 * 1000;
    case "h": return n * 3600 * 1000;
    case "d": return n * 86400 * 1000;
    default: return 30 * 60 * 1000;
  }
}

interface BulkOpts {
  filter?: string;
  target?: string;
  since?: string;
  to?: string;
  dryRun?: boolean;
  format?: string;
}

function filterNodes(opts: BulkOpts): CachedNode[] {
  const db = getCacheDb();
  let rows = db.query("SELECT * FROM nodes").all() as CachedNode[];

  if (opts.target) {
    const resolved = resolveCacheTargetReference(opts.target);
    if (!resolved) {
      exitWithError("node_not_found", `Target "${opts.target}" not found in cache`, "Run `wf cache:sync` to refresh path and subtree lookups");
    }
    const subtree = getSubtreeIds(resolved.id);
    rows = rows.filter((r) => subtree.has(r.id));
  }

  if (opts.since) {
    const cutoff = Date.now() - parseSince(opts.since);
    rows = rows.filter((r) => r.modified_at && r.modified_at * 1000 > cutoff);
  }

  if (opts.filter) {
    const parts = opts.filter.split(/\s+/);
    for (const part of parts) {
      if (part.startsWith("tag:")) {
        const tag = part.slice(4);
        rows = rows.filter((r) => `${r.name} ${r.note ?? ""}`.includes(tag));
      } else if (part.startsWith("type:")) {
        const type = part.slice(5);
        rows = rows.filter((r) => (r.line_type ?? "bullet") === type);
      } else if (part === "completed:true") {
        rows = rows.filter((r) => r.completed === 1);
      } else if (part === "completed:false") {
        rows = rows.filter((r) => r.completed === 0);
      }
    }
  }

  return rows;
}

function addBulkFlags(cmd: Command): Command {
  return cmd
    .option("--filter <expr>", "Filter expression (tag:#foo, type:todo, completed:true)")
    .option("--target <target>", "Scope to subtree")
    .option("--since <duration>", "Only nodes modified in last N (e.g. 7d)")
    .option("--dry-run", "Preview without executing")
    .option("--format <type>", "Output format (outline|json)");
}

async function executeBulk(
  operation: string,
  buildOp: (node: CachedNode, opts: BulkOpts) => LlmDocOperation,
  opts: BulkOpts,
): Promise<void> {
  if (getCacheNodeCount() === 0) {
    exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first.");
  }

  const nodes = filterNodes(opts);

  if (nodes.length === 0) {
    if (isAgentMode()) {
      console.log(JSON.stringify({ meta: { command: `node:bulk ${operation}`, wf_version: "3.1.6" }, message: "No matching nodes." }, null, 2));
    } else {
      console.log(chalk.dim("\n  No matching nodes.\n"));
    }
    return;
  }

  const useJson = opts.format === "json" || isAgentMode();

  if (opts.dryRun) {
    if (useJson) {
      console.log(JSON.stringify({
        meta: { command: `node:bulk ${operation}`, dry_run: true, wf_version: "3.1.6" },
        would_affect: nodes.length,
        nodes: nodes.slice(0, 50).map((n) => ({ id: n.id, name: cleanHtml(n.name), operation })),
      }, null, 2));
    } else {
      console.log(`\n  Would affect ${chalk.bold(String(nodes.length))} nodes:\n`);
      for (const n of nodes.slice(0, 20)) {
        console.log(`  ${chalk.green("✓")} "${cleanHtml(n.name)}"  → ${operation}`);
      }
      if (nodes.length > 20) console.log(chalk.dim(`  ...and ${nodes.length - 20} more`));
      console.log(`\n  Run without ${chalk.cyan("--dry-run")} to execute.\n`);
    }
    return;
  }

  const token = requireToken();
  const api = new WorkflowyAPI(token);

  const grouped = new Map<string, Array<{ node: CachedNode; llmOp: LlmDocOperation }>>();

  for (const node of nodes) {
    const parentId = node.parent_id ?? "root";
    if (!grouped.has(parentId)) grouped.set(parentId, []);
    grouped.get(parentId)!.push({ node, llmOp: buildOp(node, opts) });
  }

  let totalOps = 0;
  const errors: string[] = [];

  for (const [parentId, items] of grouped) {
    try {
      await api.readDoc(parentId, 1);
      await api.editDoc(parentId, items.map((i) => i.llmOp));
      markTargetDirty(parentId);
      totalOps += items.length;
    } catch (err) {
      errors.push(`${parentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (useJson) {
    const config = loadConfig();
    console.log(JSON.stringify({
      meta: { command: `node:bulk ${operation}`, timestamp: new Date().toISOString(), account: config.activeAccount, wf_version: "3.1.6" },
      message: `${operation}: ${totalOps} nodes affected`,
      total: totalOps,
      api_calls: grouped.size,
      errors: errors.length > 0 ? errors : undefined,
    }, null, 2));
  } else {
    console.log(`\n  ${chalk.green("✓")} ${operation}: ${totalOps} nodes affected (${grouped.size} API calls)\n`);
    if (errors.length > 0) {
      for (const e of errors) console.log(`  ${chalk.red("✗")} ${e}`);
      console.log("");
    }
  }
}

export function registerNodeBulk(program: Command): void {
  const bulk = program
    .command("node:bulk")
    .alias("bulk")
    .description("Bulk operations with filters (complete|delete|move)");

  addBulkFlags(
    bulk.command("complete").description("Mark all matching todos as complete")
  ).action((opts: BulkOpts) =>
    executeBulk("complete", (n) => ({ op: "update", ref: n.id, to: { x: 1 } }), opts)
  );

  addBulkFlags(
    bulk.command("delete").description("Delete all matching nodes")
  ).action((opts: BulkOpts) =>
    executeBulk("delete", (n) => ({ op: "delete", ref: n.id }), opts)
  );

  addBulkFlags(
    bulk.command("move").description("Move all matching nodes to a target")
      .option("--to <target>", "Destination parent")
  ).action((opts: BulkOpts) => {
    if (!opts.to) {
      exitWithError("missing_arg", "Move requires --to <target>", "e.g. wf node:bulk move --filter 'tag:#archive' --to @archive");
    }
    if (opts.to.startsWith("@") && opts.to.includes("/") && getCacheNodeCount() === 0) {
      exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first for path-based targets.");
    }
    const dest = resolveTargetReference(opts.to);
    if (!dest) {
      exitWithError("node_not_found", `Target "${opts.to}" could not be resolved`, "Run `wf cache:sync` to refresh path lookups");
    }
    executeBulk("move", (n) => ({ op: "move", ref: n.id, under: dest.id, position: "top" }), opts);
  });
}
