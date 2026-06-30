import { describe, expect, test } from "bun:test";
import { formatOutline } from "./compact.ts";
import type { FlatNode } from "../shared/nodes.ts";

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");

function node(overrides: Partial<FlatNode>): FlatNode {
  return {
    id: overrides.id ?? "id",
    name: overrides.name ?? "Node",
    note: overrides.note ?? null,
    type: overrides.type ?? "bullet",
    completed: overrides.completed ?? false,
    hasMore: overrides.hasMore ?? false,
    children: overrides.children ?? [],
  };
}

describe("formatOutline", () => {
  test("uses a bullet for leaf nodes", () => {
    const output = stripAnsi(formatOutline(node({ name: "Leaf" })));
    expect(output).toContain("• Leaf");
  });

  test("uses a down triangle for expanded parent nodes", () => {
    const output = stripAnsi(formatOutline(node({
      name: "Parent",
      children: [node({ name: "Child" })],
    })));

    expect(output).toContain("▾ Parent");
    expect(output).toContain("└─ • Child");
  });

  test("uses a right triangle when children are hidden by depth", () => {
    const output = stripAnsi(formatOutline(node({ name: "Collapsed", hasMore: true }), 0));
    expect(output).toContain("▸ Collapsed");
  });
});
