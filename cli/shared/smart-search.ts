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

interface TermEvidence {
  score: number;
  matched: boolean;
}

function getWords(value: string): string[] {
  return value.match(/[a-z0-9]+/g) ?? [];
}

function fuzzyDistanceLimit(term: string): number {
  if (term.length <= 4) return 1;
  if (term.length <= 8) return 2;
  return 3;
}

function levenshteinDistance(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      rowMin = Math.min(rowMin, current[j]!);
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }

  return previous[b.length]!;
}

function scoreTerm(haystack: string, words: string[], term: string): TermEvidence {
  if (haystack.includes(term)) {
    return { score: 12, matched: true };
  }

  if (term.length < 3) {
    return { score: 0, matched: false };
  }

  const maxDistance = fuzzyDistanceLimit(term);
  let bestDistance = maxDistance + 1;

  for (const word of words) {
    const distance = levenshteinDistance(term, word, maxDistance);
    if (distance < bestDistance) bestDistance = distance;
    if (bestDistance === 0) break;
  }

  if (bestDistance <= maxDistance) {
    return { score: Math.max(1, 10 - bestDistance), matched: true };
  }

  return { score: 0, matched: false };
}

function scoreCandidate(row: SearchResult, terms: string[]): number {
  const haystack = `${cleanHtml(row.name)} ${cleanHtml(row.note ?? "")}`.toLowerCase();
  const words = getWords(haystack);
  let score = 0;

  for (const term of terms) {
    const evidence = scoreTerm(haystack, words, term);
    if (!evidence.matched) return 0;
    score += evidence.score;
  }

  return score;
}

function trigramSearch(query: string, limit = 20, scopeIds?: Set<string>): SmartSearchResult[] {
  const terms = getSearchTerms(query);
  const trigramTerms = [...new Set(terms.flatMap((term) => getTrigrams(term)))];
  if (trigramTerms.length === 0) return [];

  const matchQuery = trigramTerms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" OR ");

  const candidates = searchNodesByTrigram(matchQuery, limit * 5, scopeIds)
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

function likeSearch(query: string, limit = 20, scopeIds?: Set<string>): SmartSearchResult[] {
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

  const scopeIdsArray = scopeIds ? [...scopeIds] : [];
  const scopeClause = scopeIds
    ? scopeIdsArray.length === 0
      ? " AND 0"
      : ` AND id IN (${scopeIdsArray.map(() => "?").join(", ")})`
    : "";

  const rows = db.query(`
    SELECT * FROM nodes
    WHERE ${likeConditions}${scopeClause}
    ORDER BY modified_at DESC
    LIMIT ?
  `).all(...params, ...scopeIdsArray, limit) as Array<SearchResult>;

  return rows.map((row) => ({
    ...row,
    parent_path: row.parent_id ? buildBreadcrumbDisplay(row.parent_id) : "(root)",
    rank: scoreCandidate(row, terms),
    match_type: "fuzzy" as const,
  }));
}

export function fuzzySearch(query: string, limit = 20, scopeIds?: Set<string>): SmartSearchResult[] {
  const ranked = new Map<string, SmartSearchResult>();

  for (const candidate of [...trigramSearch(query, limit, scopeIds), ...likeSearch(query, limit, scopeIds)]) {
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

function getTargetScopeIds(target?: string): Set<string> | undefined {
  if (!target) return undefined;

  const resolved = resolveCacheTargetReference(target);
  if (!resolved) return new Set();

  return getSubtreeIds(resolved.id);
}

export function tieredSearch(query: string, limit = 20, target?: string): SmartSearchResult[] {
  const scopeIds = getTargetScopeIds(target);

  // Tier 1: FTS
  const ftsResults = searchNodes(query, limit, scopeIds);
  const results: SmartSearchResult[] = ftsResults.map((r) => ({
    ...r,
    match_type: "fts" as const,
  }));

  if (results.length > 0) return results.slice(0, limit);

  // Tier 2: Fuzzy fallback only when full-text search found nothing.
  // This keeps exact human searches from being padded with weak fuzzy matches.
  const ftsIds = new Set(results.map((r) => r.id));
  const fuzzyResults = fuzzySearch(query, limit * 5, scopeIds);
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
