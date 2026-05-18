import { expect, test } from "bun:test";
import { toLlmDocId } from "./api.ts";

test("toLlmDocId converts full UUIDs to LLM doc tags", () => {
  expect(toLlmDocId("4b84d72a-a337-5897-a6e3-e3f490273d81")).toBe("e3f490273d81");
});

test("toLlmDocId leaves short tags and non-UUID targets unchanged", () => {
  expect(toLlmDocId("e3f490273d81")).toBe("e3f490273d81");
  expect(toLlmDocId("today")).toBe("today");
});
