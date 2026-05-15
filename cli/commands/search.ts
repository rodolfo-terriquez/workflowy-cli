import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { normalizeNode, cleanHtml, type FlatNode } from "../shared/nodes.ts";
import { searchNodes, getCacheNodeCount, getCacheAgeSeconds, isCacheStale } from "../shared/cache.ts";
import { formatJson } from "../output/json.ts";
import { formatTsv, formatCsv, type TsvRow } from "../shared/output-formats.ts";
import { isAgentMode } from "../agent.ts";
import { tieredSearch, smartSearch, type SmartSearchResult } from "../shared/smart-search.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("Search nodes by text content")
    .option("--tag <tag>", "Filter by tag")
    .option("--format <type>", "Output format (outline|json|tsv|csv)")
    .option("--live", "Force API search (bypass cache FTS)")
    .option("--limit <n>", "Max results", parseInt)
    .option("--smart", "Enable AI-powered semantic reranking (tier 3)")
    .option("--target <target>", "Scope search to a subtree")
    .option("--copy", "Copy output to clipboard")
    .action(
      async (
        query: string,
        opts: { tag?: string; format?: string; live?: boolean; limit?: number; smart?: boolean; target?: string; copy?: boolean }
      ) => {
        if (opts.copy) startOutputCapture();

        const hasCache = getCacheNodeCount() > 0;
        const useLive = opts.live || !hasCache;
        const limit = opts.limit ?? 20;

        if (useLive) {
          await searchLive(query, opts.tag, opts.format, limit);
        } else if (opts.smart) {
          await searchSmart(query, opts.tag, opts.format, limit, opts.target);
        } else {
          searchTiered(query, opts.tag, opts.format, limit);
        }

        await handleCopyFlag(!!opts.copy);
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

  outputResults(query, results.map((r) => ({
    id: r.id, name: r.name, note: r.note, line_type: r.type, completed: r.completed ? 1 : 0,
    parent_id: null, priority: null, created_at: null, modified_at: null, synced_at: 0,
    parent_path: "", rank: 0, match_type: "fts" as const,
  })), "live", format);
}

function searchTiered(
  query: string,
  tag?: string,
  format?: string,
  limit = 20
): void {
  let results = tieredSearch(query, limit);

  if (tag) {
    const t = tag.startsWith("#") ? tag : `#${tag}`;
    results = results.filter(
      (n) => n.name.includes(t) || (n.note && n.note?.includes(t))
    );
  }

  outputResults(query, results, "cache", format);
}

async function searchSmart(
  query: string,
  tag?: string,
  format?: string,
  limit = 20,
  target?: string,
): Promise<void> {
  if (!isAgentMode()) process.stdout.write(chalk.dim("  Searching with AI..."));

  let results = await smartSearch(query, limit, target);

  if (tag) {
    const t = tag.startsWith("#") ? tag : `#${tag}`;
    results = results.filter(
      (n) => n.name.includes(t) || (n.note && n.note?.includes(t))
    );
  }

  if (!isAgentMode()) process.stdout.write("\r");
  outputResults(query, results, "cache+smart", format);
}

function outputResults(
  query: string,
  results: SmartSearchResult[],
  source: string,
  format?: string
): void {
  const useFormat = format ?? (isAgentMode() ? "json" : "outline");

  if (useFormat === "tsv" || useFormat === "csv") {
    const rows: TsvRow[] = results.map((r) => ({
      id: r.id,
      name: cleanHtml(r.name),
      note: r.note ? cleanHtml(r.note) : "",
      type: r.line_type ?? "bullet",
      completed: r.completed ? "true" : "false",
      parent_path: r.parent_path ?? "",
    }));
    console.log(useFormat === "tsv" ? formatTsv(rows) : formatCsv(rows));
    return;
  }

  if (useFormat === "json") {
    const config = loadConfig();
    const cacheAge = getCacheAgeSeconds();
    console.log(
      formatJson({
        meta: {
          command: "search",
          query,
          timestamp: new Date().toISOString(),
          account: config.activeAccount,
          source,
          smart: source.includes("smart"),
          cache_age_seconds: cacheAge,
          cache_stale: isCacheStale(),
          smart_search_available: !!config.llm?.apiKey,
          wf_version: "3.0.0",
        },
        nodes: results.map((r) => ({
          id: r.id,
          name: cleanHtml(r.name),
          note: r.note ? cleanHtml(r.note) : null,
          type: r.line_type ?? "bullet",
          completed: r.completed === 1,
          parent_path: r.parent_path,
          match_type: r.match_type,
          hasMore: false,
          children: [],
        })),
      })
    );
    return;
  }

  const cacheAge = getCacheAgeSeconds();
  const stale = isCacheStale();

  if (stale && !isAgentMode()) {
    const age = cacheAge ? `${Math.floor(cacheAge / 60)} minutes` : "unknown time";
    console.log(`  ${chalk.yellow("⚠")} Cache is ${age} old. Run ${chalk.cyan("wf cache:sync")} to refresh.`);
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

    const matchBadge = r.match_type === "smart"
      ? chalk.magenta(" [smart]")
      : r.match_type === "fuzzy"
        ? chalk.blue(" [fuzzy]")
        : "";

    console.log(`  ${bullet} ${highlighted}${matchBadge}  ${chalk.dim(r.id)}`);
    console.log(`    ${chalk.dim("→")} ${chalk.dim(r.parent_path)}`);
    if (r.note) console.log(`    ${chalk.dim(cleanHtml(r.note))}`);
  }

  console.log("");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
