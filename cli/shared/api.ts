const API_BASE = "https://workflowy.com/api/v1";
const LLM_DOC_BASE = "https://beta.workflowy.com/api/llm/doc";

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
}

// --- LLM Doc types (tag-as-key format) ---

export interface LlmDocNode {
  [tag: string]: unknown;
}

export interface LlmDocOperation {
  op: "insert" | "update" | "delete" | "move";
  under?: string;
  after?: string;
  items?: Array<{
    n: string;
    d?: string;
    l?: string;
    x?: number;
    c?: unknown[];
  }>;
  position?: "top" | "bottom";
  ref?: string;
  to?: {
    n?: string;
    d?: string;
    l?: string;
    x?: number;
  };
}

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})$/i;

export function toLlmDocId(id: string): string {
  const match = id.match(FULL_UUID_RE);
  return match?.[1] ?? id;
}

export class WorkflowyAPI {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  // --- Token validation (standard API) ---

  async validate(): Promise<void> {
    const res = await fetch(`${API_BASE}/targets`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error("Invalid WorkFlowy API key");
    }
  }

  // --- Standard API v1 ---

  async getNode(id: string): Promise<WFNode> {
    const res = await fetch(`${API_BASE}/nodes/${id}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`API GET /nodes/${id} failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { node: WFNode };
    return data.node;
  }

  async listNodes(parentId: string): Promise<WFNode[]> {
    const res = await fetch(
      `${API_BASE}/nodes?parent_id=${encodeURIComponent(parentId)}`,
      { headers: this.headers() }
    );
    if (!res.ok) {
      throw new Error(`API GET /nodes failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { nodes: WFNode[] };
    return data.nodes.sort((a, b) => a.priority - b.priority);
  }

  async getTargets(): Promise<WFTarget[]> {
    const res = await fetch(`${API_BASE}/targets`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`API GET /targets failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { targets: WFTarget[] };
    return data.targets;
  }

  async exportAll(): Promise<WFNode[]> {
    const res = await fetch(`${API_BASE}/nodes-export`, {
      headers: this.headers(),
    });
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
    const res = await fetch(url, { headers: this.headers() });

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
      ...operation,
      under: operation.under ? toLlmDocId(operation.under) : undefined,
      after: operation.after ? toLlmDocId(operation.after) : undefined,
      ref: operation.ref ? toLlmDocId(operation.ref) : undefined,
    }));

    const res = await fetch(`${LLM_DOC_BASE}/edit`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ root: normalizedRoot, operations: normalizedOperations }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM doc edit failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
