import { expect, test } from "bun:test";
import { markdownToRichText, normalizeLlmDocOperationMarkdown, parseMarkdownBlock } from "./markdown.ts";

test("markdownToRichText converts common inline markdown to Workflowy-friendly HTML", () => {
  expect(markdownToRichText("**bold** *italic* ~~gone~~ `code`")).toBe(
    "<b>bold</b> <i>italic</i> <strike>gone</strike> <code>code</code>",
  );
});

test("markdownToRichText converts markdown links and preserves time tags", () => {
  expect(
    markdownToRichText("[Workflowy](https://workflowy.com) <time startYear=\"2026\" startMonth=\"6\" startDay=\"3\">Jun 3, 2026</time>"),
  ).toBe(
    "<a href=\"https://workflowy.com\">Workflowy</a> <time startYear=\"2026\" startMonth=\"6\" startDay=\"3\">Jun 3, 2026</time>",
  );
});

test("parseMarkdownBlock recognizes heading, todo, quote, and fenced code markers", () => {
  expect(parseMarkdownBlock("## Heading")).toEqual({ text: "Heading", lineType: "h2" });
  expect(parseMarkdownBlock("- [ ] Follow up")).toEqual({ text: "Follow up", lineType: "todo", completed: false });
  expect(parseMarkdownBlock("[x] Done")).toEqual({ text: "Done", lineType: "todo", completed: true });
  expect(parseMarkdownBlock("> Callout")).toEqual({ text: "Callout", lineType: "quote-block" });
  expect(parseMarkdownBlock("```ts\nconst x = 1;\n```")).toEqual({ text: "const x = 1;", lineType: "code-block" });
});

test("normalizeLlmDocOperationMarkdown upgrades insert and update payloads", () => {
  expect(normalizeLlmDocOperationMarkdown({
    op: "insert",
    under: "inbox",
    items: [{ n: "## Heading", d: "**note**" }],
  })).toEqual({
    op: "insert",
    under: "inbox",
    items: [{ n: "Heading", d: "<b>note</b>", l: "h2", x: undefined, c: undefined }],
  });

  expect(normalizeLlmDocOperationMarkdown({
    op: "update",
    ref: "abc123",
    to: { n: "- [x] Ship it", d: "`done`" },
  })).toEqual({
    op: "update",
    ref: "abc123",
    to: { n: "Ship it", d: "<code>done</code>", l: "todo", x: 1 },
  });
});

test("normalizeLlmDocOperationMarkdown handles note-only updates without requiring text", () => {
  expect(normalizeLlmDocOperationMarkdown({
    op: "update",
    ref: "abc123",
    to: { d: "**note only**" },
  })).toEqual({
    op: "update",
    ref: "abc123",
    to: { d: "<b>note only</b>" },
  });
});
