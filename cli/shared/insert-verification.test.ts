import { expect, test } from "bun:test";
import { verifyInsertedChild } from "./insert-verification.ts";
import type { FlatNode } from "./nodes.ts";

function makeNode(id: string, name: string): FlatNode {
  return {
    id,
    name,
    note: null,
    type: "bullet",
    completed: false,
    hasMore: false,
    children: [],
  };
}

test("verifyInsertedChild identifies a new child inserted after a sibling", () => {
  const beforeChildren = [
    makeNode("111111111111", "Before"),
    makeNode("222222222222", "After anchor"),
    makeNode("333333333333", "Later"),
  ];
  const afterChildren = [
    makeNode("111111111111", "Before"),
    makeNode("222222222222", "After anchor"),
    makeNode("444444444444", "Week 23 (Jun 1-5, 2026)"),
    makeNode("333333333333", "Later"),
  ];

  const result = verifyInsertedChild({
    beforeChildren,
    afterChildren,
    requestedText: "Week 23 (Jun 1-5, 2026)",
    afterId: "aaaaaaaa-aaaa-aaaa-aaaa-222222222222",
  });

  expect(result.status).toBe("verified");
  expect(result.createdNodeId).toBe("444444444444");
  expect(result.createdNodeText).toBe("Week 23 (Jun 1-5, 2026)");
});

test("verifyInsertedChild reports a mismatch when the inserted node text is empty", () => {
  const beforeChildren = [
    makeNode("111111111111", "Before"),
    makeNode("222222222222", "After anchor"),
  ];
  const afterChildren = [
    makeNode("111111111111", "Before"),
    makeNode("222222222222", "After anchor"),
    makeNode("444444444444", ""),
  ];

  const result = verifyInsertedChild({
    beforeChildren,
    afterChildren,
    requestedText: "Week 23 (Jun 1-5, 2026)",
    afterId: "222222222222",
  });

  expect(result.status).toBe("mismatch");
  expect(result.createdNodeId).toBe("444444444444");
  expect(result.message).toContain("instead of");
});

test("verifyInsertedChild compares against the rendered plain text form of markdown input", () => {
  const beforeChildren = [makeNode("111111111111", "Before")];
  const afterChildren = [
    makeNode("111111111111", "Before"),
    makeNode("222222222222", "Week 23"),
  ];

  const result = verifyInsertedChild({
    beforeChildren,
    afterChildren,
    requestedText: "**Week 23**",
    position: "bottom",
  });

  expect(result.status).toBe("verified");
  expect(result.createdNodeId).toBe("222222222222");
});
