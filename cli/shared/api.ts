import { loadConfig } from "./config.ts";
import { normalizeLlmDocOperationMarkdown } from "./markdown.ts";
import {
  extractRetryAfterMs,
  getRateLimitSettings,
  noteRateLimitHit,
  waitForRateLimitSlot,
  type RateLimitEndpoint,
} from "./rate-limit.ts";

const API_BASE = "https://workflowy.com/api/v1";
const LLM_DOC_BASE = "https://beta.workflowy.com/api/llm/doc";
const DEFAULT_API_TIMEOUT_MS = 30_000;
const RETRYABLE_GET_STATUSES = new Set([500, 502, 503, 504]);

// --- Standard API types (v1) ---

export interface WFNode {
  id: string;
  name: string;
  note: string | null;
  priority: number;
  data?: { layoutMode?: string };
  parent_id?: string | null;
  createdAt: number;
  modifiedAt: number;
  completedAt: number | null;
}

export interface WFTarget {
  key: string;
  type: "shortcut" | "system";
  name: string | null;
  context?: string | null;
  nodeId?: string | null;
  path?: string | null;
  kind?: "system" | "bookmark";
}

// --- LLM Doc types (tag-as-key format) ---

export interface LlmDocNode {
  [tag: string]: unknown;
}

export interface LlmDocOperation {
  op: "insert" | "update" | "delete" | "move";
  under?: string;
  after?: string;
  items?: LlmDocItem[];
  position?: "top" | "bottom";
  ref?: string;
  to?: Partial<LlmDocItem>;
}

export interface LlmDocItem {
  n: string;
  d?: string;
  l?: string;
  x?: number;
  c?: LlmDocItem[];
}

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})$/i;

export function toLlmDocId(id: string): string {
  const match = id.match(FULL_UUID_RE);
  return match?.[1] ?? id;
}

export class WorkflowyAPI {
  private token: string;
  private accountName: string;

  constructor(token: string, accountName = loadConfig().activeAccount) {
    this.token = token;
    this.accountName = accountName;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async request(url: string, init: RequestInit, endpoint: RateLimitEndpoint): Promise<Response> {
    const settings = getRateLimitSettings();
    const configuredTimeoutSeconds = Number(loadConfig().api?.timeoutSeconds);
    const timeoutMs = Number.isFinite(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0
      ? Math.floor(configuredTimeoutSeconds * 1000)
      : DEFAULT_API_TIMEOUT_MS;
    const method = (init.method ?? "GET").toUpperCase();

    for (let attempt = 0; attempt < settings.maxRetries; attempt++) {
      await waitForRateLimitSlot(this.accountName, endpoint);
      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (method === "GET" && attempt < settings.maxRetries - 1) {
          await Bun.sleep(250 * 2 ** attempt);
          continue;
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new Error(`API request timed out after ${timeoutMs}ms: ${url}`);
        }
        throw error;
      }

      if (res.status !== 429) {
        if (method === "GET" && RETRYABLE_GET_STATUSES.has(res.status) && attempt < settings.maxRetries - 1) {
          await res.body?.cancel();
          await Bun.sleep(250 * 2 ** attempt);
          continue;
        }
        return res;
      }

      const body = await res.text();
      const retryAfterMs = extractRetryAfterMs(res.headers.get("Retry-After"), body);
      await noteRateLimitHit(this.accountName, endpoint, retryAfterMs);
    }

    throw new Error("API rate limit exceeded after multiple retries.");
  }

  // --- Token validation (standard API) ---

  async validate(): Promise<void> {
    const res = await this.request(`${API_BASE}/targets`, {
      headers: this.headers(),
    }, "general");
    if (!res.ok) {
      throw new Error("Invalid WorkFlowy API key");
    }
  }

  // --- Standard API v1 ---

  async getNode(id: string): Promise<WFNode> {
    const res = await this.request(`${API_BASE}/nodes/${id}`, {
      headers: this.headers(),
    }, "general");
    if (!res.ok) {
      throw new Error(`API GET /nodes/${id} failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { node: WFNode };
    return data.node;
  }

  async listNodes(parentId: string): Promise<WFNode[]> {
    const res = await this.request(
      `${API_BASE}/nodes?parent_id=${encodeURIComponent(parentId)}`,
      { headers: this.headers() },
      "general",
    );
    if (!res.ok) {
      throw new Error(`API GET /nodes failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { nodes: WFNode[] };
    return data.nodes.sort((a, b) => a.priority - b.priority);
  }

  async getTargets(): Promise<WFTarget[]> {
    const res = await this.request(`${API_BASE}/targets`, {
      headers: this.headers(),
    }, "general");
    if (!res.ok) {
      throw new Error(`API GET /targets failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { targets: WFTarget[] };
    return data.targets;
  }

  async exportAll(): Promise<WFNode[]> {
    const res = await this.request(`${API_BASE}/nodes-export`, {
      headers: this.headers(),
    }, "export");
    if (!res.ok) {
      throw new Error(`API GET /nodes-export failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { nodes: WFNode[] };
    return data.nodes;
  }

  // --- LLM Doc API (undocumented, more efficient) ---

  async readDoc(
    nodeId: string,
    depth: number = 3
  ): Promise<Record<string, unknown>> {
    const url = `${LLM_DOC_BASE}/read/${encodeURIComponent(nodeId)}/?depth=${depth}`;
    const res = await this.request(url, { headers: this.headers() }, "general");

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM doc read failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }

  async editDoc(
    root: string,
    operations: LlmDocOperation[]
  ): Promise<Record<string, unknown>> {
    const normalizedRoot = toLlmDocId(root);
    const normalizedOperations = operations.map((operation) => ({
      ...normalizeLlmDocOperationMarkdown(operation),
      under: operation.under ? toLlmDocId(operation.under) : undefined,
      after: operation.after ? toLlmDocId(operation.after) : undefined,
      ref: operation.ref ? toLlmDocId(operation.ref) : undefined,
    }));

    const res = await this.request(`${LLM_DOC_BASE}/edit`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ root: normalizedRoot, operations: normalizedOperations }),
    }, "general");

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM doc edit failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
