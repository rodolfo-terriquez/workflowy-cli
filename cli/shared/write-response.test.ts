import { expect, test } from "bun:test";
import { uniqueNodeIds } from "./write-response.ts";

test("uniqueNodeIds removes duplicates and empty values", () => {
  expect(uniqueNodeIds([
    "node-1",
    null,
    "node-2",
    "",
    "node-1",
    undefined,
    "node-3",
  ])).toEqual(["node-1", "node-2", "node-3"]);
});
