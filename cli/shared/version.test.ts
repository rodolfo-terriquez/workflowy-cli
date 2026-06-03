import { expect, test } from "bun:test";
import { APP_VERSION } from "./version.ts";

test("APP_VERSION stays a plain semantic version", () => {
  expect(APP_VERSION).toBe("3.0.8");
});
