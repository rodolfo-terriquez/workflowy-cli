import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { normalizeNode, cleanHtml, type FlatNode } from "../shared/nodes.ts";
import { searchNodes, getCacheNodeCount, getCacheAgeSeconds, isCacheStale } from "../shared/cache.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("Search nodes by text content")
    .option("--tag <tag>", "Filter by tag")
    .option("--format <type>", "Output format (outline|json)")
    .option("--live", "Force API search (bypass cache FTS)")
    .option("--limit <n>", "Max results", parseInt)
    .action(
      async (
        query: string,
        opts: { tag?: string; format?: string; live?: boolean; limit?: number }
      ) => {
        const hasCache = getCacheNodeCount() > 0;
        const useLive = opts.live || !hasCache;
        const limit = opts.limit ?? 20;

        if (useLive) {
          await searchLive(query, opts.tag, opts.format, limit);
        } else {
          searchFromCache(query, opts.tag, opts.format, limit);
        }
      }
    );
}

async function searchLive(
  query: string,
  tag?: string,
  format?: string,
  limit = 20
): Promise<void> {
  const token = requireToken();
  const api = new WorkflowyAPI(token);

  const allNodes = await api.exportAll();
  const queryLower = query.toLowerCase();

  let results: FlatNode[] = allNodes
    .filter(
      (n) =>
        n.name.toLowerCase().includes(queryLower) ||
        (n.note && n.note.toLowerCase().includes(queryLower))
    )
    .slice(0, limit)
    .map((n) => normalizeNode(n));

  if (tag) {
    const t = tag.startsWith("#") ? tag : `#${tag}`;
    results = results.filter(
      (n) => n.name.includes(t) || (n.note && n.note.includes(t))
    );
  }

  outputResults(query, results, "live", format);
}

function searchFromCache(
  query: string,
  tag?: string,
  format?: string,
  limit = 20
): void {
  let results = searchNodes(query, limit);

  if (tag) {
    const t = tag.startsWith("#") ? tag : `#${tag}`;
    results = results.filter(
      (n) => n.name.includes(t) || (n.note && n.note?.includes(t))
    );
  }

  const cacheAge = getCacheAgeSeconds();
  const stale = isCacheStale();
  const useJson = format === "json" || isAgentMode();

  if (useJson) {
    const config = loadConfig();
    console.log(
      formatJson({
        meta: {
          command: "search",
          target: query,
          timestamp: new Date().toISOString(),
          account: config.activeAccount,
          source: "cache",
          cache_age_seconds: cacheAge,
          cache_stale: stale,
        },
        nodes: results.map((r) => ({
          id: r.id,
          name: cleanHtml(r.name),
          note: r.note ? cleanHtml(r.note) : null,
          type: r.line_type ?? "bullet",
          completed: r.completed === 1,
          parent_path: r.parent_path,
          hasMore: false,
          children: [],
        })),
      })
    );
    return;
  }

  if (stale && !isAgentMode()) {
    const age = cacheAge ? `${Math.floor(cacheAge / 60)} minutes` : "unknown time";
    console.log(`  ${chalk.yellow("⚠")} Cache is ${age} old. Run ${chalk.cyan("wf sync")} to refresh.`);
  }

  if (results.length === 0) {
    console.log(chalk.dim(`\n  No results for "${query}"\n`));
    return;
  }

  console.log(chalk.dim(`\n  ${results.length} result${results.length !== 1 ? "s" : ""} for "${query}":\n`));

  for (const r of results) {
    const name = cleanHtml(r.name);
    const bullet = r.completed
      ? chalk.green("✓")
      : r.line_type === "todo"
        ? chalk.yellow("☐")
        : chalk.dim("•");

    const highlighted = name.replace(
      new RegExp(`(${escapeRegex(query)})`, "gi"),
      chalk.yellow("$1")
    );

    console.log(`  ${bullet} ${highlighted}  ${chalk.dim(r.id)}`);
    console.log(`    ${chalk.dim("→")} ${chalk.dim(r.parent_path)}`);
    if (r.note) console.log(`    ${chalk.dim(cleanHtml(r.note))}`);
  }

  console.log("");
}

function outputResults(
  query: string,
  results: FlatNode[],
  source: string,
  format?: string
): void {
  const useJson = format === "json" || isAgentMode();

  if (useJson) {
    const config = loadConfig();
    console.log(
      formatJson({
        meta: {
          command: "search",
          target: query,
          timestamp: new Date().toISOString(),
          account: config.activeAccount,
          source,
        },
        nodes: results,
      })
    );
    return;
  }

  if (results.length === 0) {
    console.log(chalk.dim(`\n  No results for "${query}"\n`));
    return;
  }

  console.log(chalk.dim(`\n  ${results.length} result${results.length !== 1 ? "s" : ""} for "${query}":\n`));

  for (const node of results) {
    const bullet = node.completed
      ? chalk.green("✓")
      : node.type === "todo"
        ? chalk.yellow("☐")
        : chalk.dim("•");
    const name = node.name.replace(
      new RegExp(`(${escapeRegex(query)})`, "gi"),
      chalk.yellow("$1")
    );
    console.log(`  ${bullet} ${name}  ${chalk.dim(node.id)}`);
    if (node.note) console.log(`    ${chalk.dim(node.note)}`);
  }

  console.log("");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
