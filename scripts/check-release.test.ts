import { expect, test } from "bun:test";
import { getReleaseConsistencyErrors } from "./check-release.ts";

test("release metadata is internally consistent", async () => {
  expect(await getReleaseConsistencyErrors({})).toEqual([]);
});

test("release metadata rejects a mismatched tag", async () => {
  const errors = await getReleaseConsistencyErrors({
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v9.9.9",
  });
  expect(errors.some((error) => error.includes("release tag v9.9.9"))).toBe(true);
});
