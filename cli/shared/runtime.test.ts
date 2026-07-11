import { expect, test } from "bun:test";
import { tokenizeCommandLine } from "./argv.ts";
import { getSelfCliInvocation, isBundledRuntime } from "./runtime.ts";

test("tokenizeCommandLine preserves quoted and escaped arguments", () => {
  expect(tokenizeCommandLine('node:add @inbox "two words" path\\ with\\ spaces')).toEqual([
    "node:add",
    "@inbox",
    "two words",
    "path with spaces",
  ]);
});

test("tokenizeCommandLine rejects unterminated quotes", () => {
  expect(() => tokenizeCommandLine('search "unfinished')).toThrow("Unterminated quote");
});

test("getSelfCliInvocation uses source with Bun and self for compiled binaries", () => {
  expect(getSelfCliInvocation(["version"], {
    agent: true,
    mainPath: "/repo/cli/wf.ts",
    execPath: "/opt/homebrew/bin/bun",
  })).toEqual(["bun", "run", "/repo/cli/wf.ts", "--agent", "version"]);

  expect(getSelfCliInvocation(["version"], {
    agent: true,
    mainPath: "/$bunfs/root/cli/wf.ts",
    execPath: "/usr/local/bin/wf",
  })).toEqual(["/usr/local/bin/wf", "--agent", "version"]);

  expect(getSelfCliInvocation(["version"], {
    agent: true,
    mainPath: "B:/~BUN/root/cli/wf.ts",
    execPath: "D:\\a\\workflowy-cli\\dist\\wf.exe",
  })).toEqual(["D:\\a\\workflowy-cli\\dist\\wf.exe", "--agent", "version"]);
});

test("isBundledRuntime recognizes Bun executable paths on every platform", () => {
  expect(isBundledRuntime("/$bunfs/root/cli/wf.ts")).toBe(true);
  expect(isBundledRuntime("B:/~BUN/root/cli/wf.ts")).toBe(true);
  expect(isBundledRuntime("B:\\~BUN\\root\\cli\\wf.ts")).toBe(true);
  expect(isBundledRuntime("/repo/cli/wf.ts")).toBe(false);
  expect(isBundledRuntime("C:\\repo\\cli\\wf.ts")).toBe(false);
});
