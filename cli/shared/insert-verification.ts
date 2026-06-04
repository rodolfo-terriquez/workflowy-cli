import { toLlmDocId } from "./api.ts";
import { markdownToRichText, parseMarkdownBlock } from "./markdown.ts";
import { cleanHtml, type FlatNode } from "./nodes.ts";

export interface InsertVerificationResult {
  status: "verified" | "mismatch" | "not_found" | "ambiguous";
  createdNodeId: string | null;
  createdNodeText: string | null;
  message: string;
}

interface VerifyInsertedChildOptions {
  beforeChildren: FlatNode[];
  afterChildren: FlatNode[];
  requestedText: string;
  afterId?: string;
  position?: "top" | "bottom";
}

export function verifyInsertedChild(options: VerifyInsertedChildOptions): InsertVerificationResult {
  const beforeIds = new Set(options.beforeChildren.map((child) => child.id));
  const newChildren = options.afterChildren.filter((child) => !beforeIds.has(child.id));

  const candidate = findInsertedChildCandidate(options.afterChildren, newChildren, {
    afterId: options.afterId,
    position: options.position ?? "bottom",
  });

  if (!candidate) {
    return {
      status: newChildren.length === 0 ? "not_found" : "ambiguous",
      createdNodeId: null,
      createdNodeText: null,
      message: newChildren.length === 0
        ? "Inserted node was not discoverable from the live parent snapshot after the write."
        : "Multiple new children appeared after the write and the inserted node could not be identified reliably.",
    };
  }

  const expectedText = normalizeRequestedText(options.requestedText);
  const actualText = candidate.name.trim();

  if (actualText !== expectedText) {
    return {
      status: "mismatch",
      createdNodeId: candidate.id,
      createdNodeText: candidate.name,
      message: `Inserted node ${candidate.id} has text ${JSON.stringify(candidate.name)} instead of ${JSON.stringify(expectedText)}.`,
    };
  }

  return {
    status: "verified",
    createdNodeId: candidate.id,
    createdNodeText: candidate.name,
    message: `Verified inserted node ${candidate.id}.`,
  };
}

function findInsertedChildCandidate(
  afterChildren: FlatNode[],
  newChildren: FlatNode[],
  options: { afterId?: string; position: "top" | "bottom" },
): FlatNode | null {
  const newChildIds = new Set(newChildren.map((child) => child.id));

  if (options.afterId) {
    const afterTag = toLlmDocId(options.afterId);
    const afterIndex = afterChildren.findIndex((child) => child.id === afterTag);
    if (afterIndex >= 0) {
      const nextChild = afterChildren[afterIndex + 1];
      if (nextChild && newChildIds.has(nextChild.id)) {
        return nextChild;
      }
    }
  } else if (options.position === "top") {
    const firstChild = afterChildren[0];
    if (firstChild && newChildIds.has(firstChild.id)) {
      return firstChild;
    }
  } else {
    const lastChild = afterChildren.at(-1);
    if (lastChild && newChildIds.has(lastChild.id)) {
      return lastChild;
    }
  }

  if (newChildren.length === 1) {
    return newChildren[0] ?? null;
  }

  return null;
}

function normalizeRequestedText(text: string): string {
  const block = parseMarkdownBlock(text);
  if (block.lineType === "code-block") {
    return block.text.trim();
  }
  return cleanHtml(markdownToRichText(block.text)).trim();
}
