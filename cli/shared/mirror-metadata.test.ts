import { expect, test } from "bun:test";
import { describeMirrorRelationship } from "../commands/mirror.ts";
import type { WFNode } from "./api.ts";
import { getMirrorRelationship, parseLlmDocNode } from "./nodes.ts";

function makeNode(mirror: NonNullable<WFNode["data"]>["mirror"]): WFNode {
  return {
    id: "node-1",
    name: "Mirror",
    note: null,
    priority: 0,
    data: { layoutMode: "bullets", mirror },
    parent_id: null,
    createdAt: 1,
    modifiedAt: 2,
    completedAt: null,
  };
}

test("null origin_id still identifies a mirror when the origin is inaccessible", () => {
  expect(describeMirrorRelationship(makeNode({ origin_id: null }))).toEqual({
    role: "mirror",
    origin_id: null,
    mirror_ids: [],
  });
  expect(getMirrorRelationship({ origin_id: null })).toEqual({
    role: "mirror",
    origin_id: null,
    mirror_ids: [],
  });
});

test("an explicit mirror_ids field identifies an origin even when empty", () => {
  expect(getMirrorRelationship({ mirror_ids: [] })).toEqual({
    role: "origin",
    origin_id: null,
    mirror_ids: [],
  });
});

test("LLM document parsing preserves compact mirror metadata", () => {
  const parsed = parseLlmDocNode({ abcdef123456: "Shared item", m: "origin123456" });
  expect(parsed.mirror).toEqual({
    role: "mirror",
    origin_id: "origin123456",
    mirror_ids: [],
  });
});
