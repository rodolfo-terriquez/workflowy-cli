import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI, type WFNode } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { normalizeNode, cleanHtml, parseLlmDocResponse, type FlatNode } from "../shared/nodes.ts";
import { getCacheNodeCount, getCacheAgeSeconds, isCacheStale } from "../shared/cache.ts";
import { formatJson } from "../output/json.ts";
import { formatTsv, formatCsv, type TsvRow } from "../shared/output-formats.ts";
import { isAgentMode } from "../agent.ts";
import { tieredSearch, smartSearch, type SmartSearchResult } from "../shared/smart-search.ts";
import { startOutputCapture, handleCopyFlag } from "../shared/copy-wrapper.ts";
import { resolveCacheTargetReference, resolveTargetReference } from "../shared/path.ts";
import { exitWithError } from "../shared/errors.ts";

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
          await searchLive(query, opts.tag, opts.format, limit, opts.target);
        } else if (opts.smart) {
          await searchSmart(query, opts.tag, opts.format, limit, opts.target);
        } else {
          searchTiered(query, opts.tag, opts.format, limit, opts.target);
        }

        await handleCopyFlag(!!opts.copy);
      }
    );
}

async function searchLive(
  query: string,
  tag?: string,
  format?: string,
  limit = 20,
  target?: string,
): Promise<void> {
  const token = requireToken();
  const api = new WorkflowyAPI(token);

  const allNodes = await api.exportAll();
  const targetId = target ? await resolveLiveSearchTargetId(target, api) : null;
  const subtreeIds = targetId ? buildLiveSubtreeIds(allNodes, targetId) : null;
  const queryLower = query.toLowerCase();

  let results: FlatNode[] = allNodes
    .filter(
      (n) => {
        if (subtreeIds && !subtreeIds.has(n.id)) return false;
        return (
          n.name.toLowerCase().includes(queryLower) ||
          (!!n.note && n.note.toLowerCase().includes(queryLower))
        );
      }
    )
    .slice(0, limit)
    .map((n) => normalizeNode(n));

  if (tag) {
    const t = tag.startsWith("#") ? tag : `#${tag}`;
    results = results.filter(
      (n) => n.name.includes(t) || (n.note && n.note.includes(t))
    );
  }

  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  outputResults(query, results.map((r) => ({
    id: r.id, name: r.name, note: r.note, line_type: r.type, completed: r.completed ? 1 : 0,
    parent_id: nodeById.get(r.id)?.parent_id ?? null, priority: null, created_at: null, modified_at: null, synced_at: 0,
    parent_path: buildLiveParentPath(nodeById.get(r.id)?.parent_id ?? null, nodeById), rank: 0, match_type: "fts" as const,
  })), "live", format, target);
}

function searchTiered(
  query: string,
  tag?: string,
  format?: string,
  limit = 20,
  target?: string,
): void {
  if (target && !resolveCacheTargetReference(target)) {
    exitWithError("node_not_found", `Target "${target}" not found in cache`, "Run `wf cache:sync` to refresh path and subtree lookups");
  }

  let results = tieredSearch(query, limit, target);

  if (tag) {
    const t = tag.startsWith("#") ? tag : `#${tag}`;
    results = results.filter(
      (n) => n.name.includes(t) || (n.note && n.note?.includes(t))
    );
  }

  outputResults(query, results, "cache", format, target);
}

async function searchSmart(
  query: string,
  tag?: string,
  format?: string,
  limit = 20,
  target?: string,
): Promise<void> {
  if (!isAgentMode()) process.stdout.write(chalk.dim("  Searching with AI..."));

  if (target && !resolveCacheTargetReference(target)) {
    exitWithError("node_not_found", `Target "${target}" not found in cache`, "Run `wf cache:sync` to refresh path and subtree lookups");
  }

  let results = await smartSearch(query, limit, target);

  if (tag) {
    const t = tag.startsWith("#") ? tag : `#${tag}`;
    results = results.filter(
      (n) => n.name.includes(t) || (n.note && n.note?.includes(t))
    );
  }

  if (!isAgentMode()) process.stdout.write("\r");
  outputResults(query, results, "cache+smart", format, target);
}

function outputResults(
  query: string,
  results: SmartSearchResult[],
  source: string,
  format?: string,
  target?: string,
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
          target: target ?? null,
          timestamp: new Date().toISOString(),
          account: config.activeAccount,
          source,
          smart: source.includes("smart"),
          cache_age_seconds: cacheAge,
          cache_stale: isCacheStale(),
          smart_search_available: !!config.llm?.apiKey,
          wf_version: "3.0.9",
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

function buildLiveSubtreeIds(nodes: WFNode[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    const siblings = childrenByParent.get(node.parent_id) ?? [];
    siblings.push(node.id);
    childrenByParent.set(node.parent_id, siblings);
  }

  const ids = new Set<string>();
  const queue = [rootId];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (ids.has(current)) continue;

    ids.add(current);
    for (const childId of childrenByParent.get(current) ?? []) {
      queue.push(childId);
    }
  }

  return ids;
}

function buildLiveParentPath(parentId: string | null, nodesById: Map<string, WFNode>): string {
  if (!parentId) return "(root)";

  const parts: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = parentId;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodesById.get(currentId);
    if (!node) break;
    parts.unshift(cleanHtml(node.name));
    currentId = node.parent_id ?? null;
  }

  return parts.length > 0 ? parts.join(" > ") : "(root)";
}

async function resolveLiveSearchTargetId(target: string, api: WorkflowyAPI): Promise<string> {
  const cached = resolveCacheTargetReference(target);
  if (cached) return cached.id;

  if (target.startsWith("@") && target.includes("/")) {
    exitWithError("node_not_found", `Target path "${target}" not found in cache`, "Run `wf cache:sync` first for path-scoped live search");
  }

  const resolved = resolveTargetReference(target);
  if (!resolved) {
    exitWithError("node_not_found", `Target "${target}" could not be resolved`);
  }

  if (resolved.source === "direct") {
    return resolved.id;
  }

  const data = await api.readDoc(resolved.id, 0);
  const { node } = parseLlmDocResponse(data);
  return node.id;
}
