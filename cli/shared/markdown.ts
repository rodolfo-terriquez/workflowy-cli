import type { LlmDocItem, LlmDocOperation } from "./api.ts";

interface ParsedMarkdownBlock {
  text: string;
  lineType?: string;
  completed?: boolean;
}

interface HtmlStash {
  placeholder: string;
  html: string;
}

const HTML_TAG_RE = /<\/?[A-Za-z][^>]*>/g;
const FENCED_CODE_BLOCK_RE = /^```[^\n]*\n([\s\S]*?)\n```$/;
const TODO_MARKER_RE = /^(?:-\s*)?\[( |x|X)\]\s+([\s\S]+)$/;
const HEADING_MARKER_RE = /^(#{1,3})\s+(.+)$/;

export function normalizeLlmDocOperationMarkdown(operation: LlmDocOperation): LlmDocOperation {
  return {
    ...operation,
    ...(operation.items ? { items: operation.items.map(normalizeLlmDocItemMarkdown) } : {}),
    ...(operation.to ? { to: normalizeLlmDocUpdateFields(operation.to) } : {}),
  };
}

function normalizeLlmDocItemMarkdown(item: LlmDocItem): LlmDocItem {
  const normalized = normalizeLlmDocItemFields(item);
  return {
    ...normalized,
    c: item.c?.map(normalizeLlmDocItemMarkdown),
  };
}

function normalizeLlmDocItemFields<T extends Pick<LlmDocItem, "n" | "d" | "l" | "x">>(item: T): T {
  const block = parseMarkdownBlock(item.n);
  const lineType = item.l ?? block.lineType;
  const completed = item.x ?? (block.completed === undefined ? undefined : (block.completed ? 1 : 0));

  return {
    ...item,
    n: lineType === "code-block" ? escapePlainText(block.text) : markdownToRichText(block.text),
    d: item.d === undefined ? undefined : markdownToRichText(item.d),
    l: lineType,
    x: completed,
  };
}

function normalizeLlmDocUpdateFields(
  item: Partial<Pick<LlmDocItem, "n" | "d" | "l" | "x">>,
): Partial<Pick<LlmDocItem, "n" | "d" | "l" | "x">> {
  if (item.n === undefined) {
    return {
      ...item,
      d: item.d === undefined ? undefined : markdownToRichText(item.d),
    };
  }

  const block = parseMarkdownBlock(item.n);
  const lineType = item.l ?? block.lineType;
  const completed = item.x ?? (block.completed === undefined ? undefined : (block.completed ? 1 : 0));

  return {
    ...item,
    n: lineType === "code-block" ? escapePlainText(block.text) : markdownToRichText(block.text),
    d: item.d === undefined ? undefined : markdownToRichText(item.d),
    l: lineType,
    x: completed,
  };
}

export function parseMarkdownBlock(markdown: string): ParsedMarkdownBlock {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const trimmed = normalized.trim();

  if (!trimmed) {
    return { text: normalized };
  }

  const fencedCode = trimmed.match(FENCED_CODE_BLOCK_RE);
  if (fencedCode) {
    return { text: fencedCode[1] ?? "", lineType: "code-block" };
  }

  const todo = trimmed.match(TODO_MARKER_RE);
  if (todo) {
    return {
      text: todo[2] ?? "",
      lineType: "todo",
      completed: (todo[1] ?? "").toLowerCase() === "x",
    };
  }

  if (!trimmed.includes("\n")) {
    const heading = trimmed.match(HEADING_MARKER_RE);
    if (heading) {
      return {
        text: heading[2] ?? "",
        lineType: `h${heading[1]?.length ?? 1}`,
      };
    }

    if (trimmed.startsWith("> ")) {
      return {
        text: trimmed.slice(2),
        lineType: "quote-block",
      };
    }
  }

  return { text: normalized };
}

export function markdownToRichText(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const stashed: HtmlStash[] = [];
  const stash = (html: string): string => {
    const placeholder = `\u0007WFHTML${stashed.length}\u0007`;
    stashed.push({ placeholder, html });
    return placeholder;
  };

  let text = normalized.replace(HTML_TAG_RE, (match) => stash(match));
  text = escapePlainText(text);

  text = text.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${code}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    return stash(`<a href="${escapeAttribute(url)}">${label}</a>`);
  });
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<b><i>$1</i></b>");
  text = text.replace(/___([^_\n]+)___/g, "<b><i>$1</i></b>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  text = text.replace(/~~([^~\n]+)~~/g, "<strike>$1</strike>");
  text = text.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  text = text.replace(/_([^_\n]+)_/g, "<i>$1</i>");
  text = text.replace(/\n/g, "<br>");

  for (const entry of stashed) {
    text = text.replaceAll(entry.placeholder, entry.html);
  }

  return text;
}

function escapePlainText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(text: string): string {
  return escapePlainText(text).replaceAll('"', "&quot;");
}
