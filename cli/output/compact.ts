import chalk from "chalk";
import type { FlatNode } from "../shared/nodes.ts";

function getBullet(node: FlatNode): { bullet: string; text: string } {
  const hasVisibleChildren = node.children.length > 0;
  const hasHiddenChildren = node.hasMore;

  switch (node.type) {
    case "todo":
      if (node.completed) {
        return { bullet: chalk.green("✓"), text: chalk.strikethrough(chalk.dim(node.name)) };
      }
      return { bullet: chalk.yellow("☐"), text: node.name };
    case "h1":
      return { bullet: chalk.cyan("■"), text: chalk.bold(node.name) };
    case "h2":
      return { bullet: chalk.cyan("▪"), text: chalk.bold.dim(node.name) };
    case "h3":
      return { bullet: chalk.cyan("▸"), text: chalk.underline(node.name) };
    case "code-block":
      return { bullet: chalk.dim("»"), text: chalk.dim(node.name) };
    case "quote-block":
      return { bullet: chalk.dim("│"), text: chalk.italic(node.name) };
    default:
      return {
        bullet: chalk.dim(hasVisibleChildren ? "▾" : hasHiddenChildren ? "▸" : "•"),
        text: node.completed ? chalk.strikethrough(chalk.dim(node.name)) : node.name,
      };
  }
}

export function formatOutline(
  node: FlatNode,
  maxDepth?: number,
  currentDepth = 0,
  prefix = "",
  isLast = true
): string {
  const lines: string[] = [];
  const { bullet, text } = getBullet(node);

  if (currentDepth === 0) {
    lines.push(`${bullet} ${text}`);
    if (node.note) {
      lines.push(`  ${chalk.dim(node.note)}`);
    }
  } else {
    const connector = isLast ? chalk.dim("└─") : chalk.dim("├─");
    lines.push(`${prefix}${connector} ${bullet} ${text}`);
    if (node.note) {
      const notePrefix = prefix + (isLast ? "   " : chalk.dim("│") + "  ");
      lines.push(`${notePrefix}  ${chalk.dim(node.note)}`);
    }
  }

  if (maxDepth === undefined || currentDepth < maxDepth) {
    const childPrefix = currentDepth === 0
      ? ""
      : prefix + (isLast ? "   " : chalk.dim("│") + "  ");

    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const childIsLast = i === children.length - 1 && !node.hasMore;
      lines.push(formatOutline(child, maxDepth, currentDepth + 1, childPrefix, childIsLast));
    }

    if (node.hasMore) {
      const moreConnector = chalk.dim("└─");
      lines.push(`${childPrefix}${moreConnector} ${chalk.dim("…more")}`);
    }
  }

  return lines.join("\n");
}

export function formatOutlineList(
  nodes: FlatNode[],
  depth?: number
): string {
  return nodes.map((n) => formatOutline(n, depth, 0)).join("\n");
}
