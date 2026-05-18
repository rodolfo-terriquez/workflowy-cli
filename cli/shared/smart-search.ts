import { getCacheDb, searchNodes, searchNodesByTrigram, type SearchResult, buildBreadcrumbDisplay, getSubtreeIds } from "./cache.ts";
import { cleanHtml } from "./nodes.ts";
import { loadConfig, type LlmConfig } from "./config.ts";
import { resolveCacheTargetReference } from "./path.ts";

export interface SmartSearchResult extends SearchResult {
  match_type: "fts" | "fuzzy" | "smart";
}

function getSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function getTrigrams(term: string): string[] {
  if (term.length < 3) return [];

  const trigrams = new Set<string>();
  for (let i = 0; i <= term.length - 3; i += 1) {
    trigrams.add(term.slice(i, i + 3));
  }

  return [...trigrams];
}

function getRelaxedTerm(term: string): string {
  if (term.length <= 4) return term;
  return term.slice(0, 4);
}

function scoreCandidate(row: SearchResult, terms: string[]): number {
  const haystack = `${cleanHtml(row.name)} ${cleanHtml(row.note ?? "")}`.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 12;
      continue;
    }

    const relaxedTerm = getRelaxedTerm(term);
    if (relaxedTerm !== term && haystack.includes(relaxedTerm)) {
      score += 6;
    }

    for (const trigram of getTrigrams(term)) {
      if (haystack.includes(trigram)) {
        score += 1;
      }
    }
  }

  return score;
}

function trigramSearch(query: string, limit = 20): SmartSearchResult[] {
  const terms = getSearchTerms(query);
  const trigramTerms = [...new Set(terms.flatMap((term) => getTrigrams(term)))];
  if (trigramTerms.length === 0) return [];

  const matchQuery = trigramTerms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" OR ");

  const candidates = searchNodesByTrigram(matchQuery, limit * 5)
    .map((row) => ({
      row,
      score: scoreCandidate(row, terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.row.modified_at ?? 0) - (a.row.modified_at ?? 0);
    })
    .slice(0, limit);

  return candidates.map(({ row, score }) => ({
    ...row,
    rank: score,
    match_type: "fuzzy" as const,
  }));
}

function likeSearch(query: string, limit = 20): SmartSearchResult[] {
  const db = getCacheDb();
  const terms = getSearchTerms(query);
  if (terms.length === 0) return [];

  const likeConditions = terms
    .map((term) => {
      const patterns = [term];
      const relaxedTerm = getRelaxedTerm(term);
      if (relaxedTerm !== term) {
        patterns.push(relaxedTerm);
      }

      return `(${patterns.map(() => "(LOWER(name) LIKE ? OR LOWER(note) LIKE ?)").join(" OR ")})`;
    })
    .join(" AND ");

  const params = terms.flatMap((term) => {
    const patterns = [term];
    const relaxedTerm = getRelaxedTerm(term);
    if (relaxedTerm !== term) {
      patterns.push(relaxedTerm);
    }

    return patterns.flatMap((value) => {
      const lower = `%${value}%`;
      return [lower, lower];
    });
  });

  const rows = db.query(`
    SELECT * FROM nodes
    WHERE ${likeConditions}
    ORDER BY modified_at DESC
    LIMIT ?
  `).all(...params, limit) as Array<SearchResult>;

  return rows.map((row) => ({
    ...row,
    parent_path: row.parent_id ? buildBreadcrumbDisplay(row.parent_id) : "(root)",
    rank: scoreCandidate(row, terms),
    match_type: "fuzzy" as const,
  }));
}

export function fuzzySearch(query: string, limit = 20): SmartSearchResult[] {
  const ranked = new Map<string, SmartSearchResult>();

  for (const candidate of [...trigramSearch(query, limit), ...likeSearch(query, limit)]) {
    const existing = ranked.get(candidate.id);
    if (!existing || candidate.rank > existing.rank) {
      ranked.set(candidate.id, candidate);
    }
  }

  return [...ranked.values()]
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return (b.modified_at ?? 0) - (a.modified_at ?? 0);
    })
    .slice(0, limit);
}

function scopeResultsToTarget(results: SmartSearchResult[], target?: string): SmartSearchResult[] {
  if (!target) return results;

  const resolved = resolveCacheTargetReference(target);
  if (!resolved) return [];

  const subtreeIds = getSubtreeIds(resolved.id);
  return results.filter((result) => subtreeIds.has(result.id));
}

export function tieredSearch(query: string, limit = 20, target?: string): SmartSearchResult[] {
  // Tier 1: FTS
  const ftsResults = searchNodes(query, limit);
  const results: SmartSearchResult[] = scopeResultsToTarget(ftsResults.map((r) => ({
    ...r,
    match_type: "fts" as const,
  })), target);

  if (results.length >= 3) return results.slice(0, limit);

  // Tier 2: Fuzzy fallback
  const ftsIds = new Set(results.map((r) => r.id));
  const fuzzyResults = scopeResultsToTarget(fuzzySearch(query, limit * 5), target);
  for (const r of fuzzyResults) {
    if (!ftsIds.has(r.id)) {
      results.push(r);
      ftsIds.add(r.id);
    }
  }

  return results.slice(0, limit);
}

export async function smartSearch(
  query: string,
  limit = 20,
  target?: string
): Promise<SmartSearchResult[]> {
  const candidates = tieredSearch(query, 100, target);

  const config = loadConfig();
  const llmConfig: LlmConfig = config.llm ?? {};
  const model = llmConfig.model ?? "google/gemini-flash-2.5";
  const apiKey = llmConfig.apiKey;

  if (!apiKey) {
    return candidates.slice(0, limit);
  }

  const nodeList = candidates
    .map((c) => `${c.id}|${cleanHtml(c.name)}`)
    .join("\n");

  const prompt = `User searched: "${query}"
Nodes (id|name):
${nodeList}

Return a JSON object with a single field "ids": an array of IDs that match the user's search intent.
Include both exact and conceptually related matches. Order by relevance.
Return ONLY valid JSON.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/rodolfo-terriquez/workflowy-cli",
        "X-Title": "WorkFlowy CLI",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });

    if (!response.ok) return candidates.slice(0, limit);

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) return candidates.slice(0, limit);

    const parsed = JSON.parse(content) as { ids: string[] };
    if (!Array.isArray(parsed.ids)) return candidates.slice(0, limit);

    const idSet = new Set(parsed.ids);
    const candidateMap = new Map(candidates.map((c) => [c.id, c]));

    const smartResults: SmartSearchResult[] = [];
    for (const id of parsed.ids) {
      const node = candidateMap.get(id);
      if (node) {
        smartResults.push({ ...node, match_type: "smart" });
      }
    }

    // Include any FTS/fuzzy results the LLM didn't mention
    for (const c of candidates) {
      if (!idSet.has(c.id) && smartResults.length < limit) {
        smartResults.push(c);
      }
    }

    return smartResults.slice(0, limit);
  } catch {
    return candidates.slice(0, limit);
  }
}
