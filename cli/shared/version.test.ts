import { expect, test } from "bun:test";
import { APP_VERSION, formatCliVersion } from "./version.ts";

test("formatCliVersion returns the app version when no git head is available", () => {
  expect(formatCliVersion(APP_VERSION, null)).toBe(APP_VERSION);
  expect(formatCliVersion(APP_VERSION, undefined)).toBe(APP_VERSION);
});

test("formatCliVersion appends the git head when available", () => {
  expect(formatCliVersion(APP_VERSION, "d44689d")).toBe(`${APP_VERSION}+d44689d`);
});
