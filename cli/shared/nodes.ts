import type { WFNode } from "./api.ts";

function cleanHtml(html: string): string {
  let text = html;

  // <br> → newline
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // <a href="url">label</a> → label (url)
  text = text.replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, (_, url, label) => {
    if (label === url || label === "Open in Google Calendar") {
      return url;
    }
    return `${label} (${url})`;
  });

  // <time ...>May 14, 2026</time> → May 14, 2026
  text = text.replace(/<time[^>]*>([^<]*)<\/time>/gi, "$1");

  // <b>text</b> / <i>text</i> / <code>text</code> → text
  text = text.replace(/<\/?(b|i|u|em|strong|code|strike|span|div|br\s*\/?)>/gi, "");

  // Catch any remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  return text.trim();
}

export { cleanHtml };

export interface FlatNode {
  id: string;
  name: string;
  note: string | null;
  type: "bullet" | "todo" | "h1" | "h2" | "h3" | "code-block" | "quote-block" | "table" | "p";
  completed: boolean;
  hasMore: boolean;
  children: FlatNode[];
}

// --- Standard API normalization ---

export function normalizeNode(raw: WFNode, children: FlatNode[] = []): FlatNode {
  const layoutMode = raw.data?.layoutMode ?? "bullets";
  return {
    id: raw.id,
    name: cleanHtml(raw.name),
    note: raw.note ? cleanHtml(raw.note) : null,
    type: layoutModeToType(layoutMode),
    completed: raw.completedAt !== null && raw.completedAt !== undefined,
    hasMore: false,
    children,
  };
}

// --- LLM Doc tag-as-key format parsing ---
// Format: { "b605f0e85a4a": "My Project", "d": "note", "c": [...], "l": "todo", "x": 1 }
// The first key that looks like a hex tag is the node ID, its value is the name.

const RESERVED_KEYS = new Set(["d", "c", "l", "x", "+", "m", "ancestors"]);

export function parseLlmDocNode(raw: Record<string, unknown>): FlatNode {
  let id = "";
  let name = "";

  for (const key of Object.keys(raw)) {
    if (!RESERVED_KEYS.has(key)) {
      id = key;
      name = String(raw[key] ?? "");
      break;
    }
  }

  const note = raw.d ? cleanHtml(String(raw.d)) : null;
  const lineType = raw.l ? String(raw.l) : null;
  const completed = raw.x === 1;
  const hasMore = raw["+"] === 1;

  const type = lineType ? layoutModeToType(lineType) : "bullet";
  name = cleanHtml(name);

  const children: FlatNode[] = [];
  if (Array.isArray(raw.c)) {
    for (const child of raw.c) {
      if (typeof child === "object" && child !== null) {
        children.push(parseLlmDocNode(child as Record<string, unknown>));
      }
    }
  }

  return { id, name, note, type, completed, hasMore, children };
}

export function parseLlmDocResponse(
  data: Record<string, unknown>
): { node: FlatNode; ancestors: Array<{ id: string; name: string }> } {
  const ancestors: Array<{ id: string; name: string }> = [];

  if (Array.isArray(data.ancestors)) {
    for (const anc of data.ancestors) {
      if (typeof anc === "object" && anc !== null) {
        for (const [key, val] of Object.entries(anc as Record<string, unknown>)) {
          ancestors.push({ id: key, name: cleanHtml(String(val)) });
        }
      }
    }
  }

  const node = parseLlmDocNode(data);
  return { node, ancestors };
}

// --- Shared utilities ---

function layoutModeToType(mode: string): FlatNode["type"] {
  switch (mode) {
    case "todo": return "todo";
    case "h1": return "h1";
    case "h2": return "h2";
    case "h3": return "h3";
    case "code-block":
    case "code": return "code-block";
    case "quote-block":
    case "quote": return "quote-block";
    case "table": return "table";
    case "p": return "p";
    default: return "bullet";
  }
}

export function flattenTree(node: FlatNode): FlatNode[] {
  const result: FlatNode[] = [node];
  for (const child of node.children) {
    result.push(...flattenTree(child));
  }
  return result;
}
