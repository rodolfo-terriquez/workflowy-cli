import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findWorkflowyRepoRoot,
  findWorkflowyRepoRootFromArgv,
  getMcpRestartMode,
  getSelfUpdateCandidates,
  isWorkflowyRepoRoot,
  parseProcessListLine,
  readRepoAppVersion,
  splitCommandLine,
} from "./self-update.ts";

test("isWorkflowyRepoRoot detects the workflowy-cli checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "workflowy-cli-self-update-"));

  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "cli"), { recursive: true });
    writeFileSync(join(root, "cli", "wf.ts"), "#!/usr/bin/env bun\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@workflowy/cli" }));

    expect(isWorkflowyRepoRoot(root)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findWorkflowyRepoRoot walks up from a built binary path", () => {
  const root = mkdtempSync(join(tmpdir(), "workflowy-cli-self-update-"));

  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "cli"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "cli", "wf.ts"), "#!/usr/bin/env bun\n");
    writeFileSync(join(root, "dist", "wf"), "binary");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@workflowy/cli" }));

    const detected = findWorkflowyRepoRoot([join(root, "dist", "wf")]);
    expect(detected).toBe(realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getSelfUpdateCandidates includes executable, argv entry, cwd, and module dir", () => {
  const candidates = getSelfUpdateCandidates(
    "/tmp/workflowy-cli/dist/wf",
    "/tmp/current",
    ["wf", "/tmp/workflowy-cli/cli/wf.ts"],
    "/tmp/workflowy-cli/cli",
  );

  expect(candidates).toContain("/tmp/workflowy-cli/dist/wf");
  expect(candidates).toContain("/tmp/workflowy-cli/cli/wf.ts");
  expect(candidates).toContain("/tmp/current");
  expect(candidates).toContain("/tmp/workflowy-cli/cli");
});

test("splitCommandLine handles quoted arguments", () => {
  expect(splitCommandLine('/usr/local/bin/wf mcp --port 3399 --tools "read,add,batch"')).toEqual([
    "/usr/local/bin/wf",
    "mcp",
    "--port",
    "3399",
    "--tools",
    "read,add,batch",
  ]);
});

test("parseProcessListLine extracts pid and argv", () => {
  expect(parseProcessListLine('77364 /Users/rodolfo/.bun/bin/wf mcp --port 3399')).toEqual({
    pid: 77364,
    command: "/Users/rodolfo/.bun/bin/wf mcp --port 3399",
    argv: ["/Users/rodolfo/.bun/bin/wf", "mcp", "--port", "3399"],
  });
});

test("findWorkflowyRepoRootFromArgv resolves symlinked wf binaries", () => {
  const root = mkdtempSync(join(tmpdir(), "workflowy-cli-self-update-"));

  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "cli"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "cli", "wf.ts"), "#!/usr/bin/env bun\n");
    writeFileSync(join(root, "dist", "wf"), "binary");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@workflowy/cli" }));
    symlinkSync(join(root, "dist", "wf"), join(root, "bin", "wf"));

    expect(findWorkflowyRepoRootFromArgv([join(root, "bin", "wf"), "mcp"])).toBe(realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getMcpRestartMode distinguishes restartable port processes", () => {
  expect(getMcpRestartMode(["/tmp/wf", "mcp"])).toBe("stop_only");
  expect(getMcpRestartMode(["/tmp/wf", "mcp", "--port", "3399"])).toBe("restart");
  expect(getMcpRestartMode(["/tmp/wf", "search", "launch"])).toBeNull();
});

test("readRepoAppVersion returns the package version from the repo root", () => {
  const root = mkdtempSync(join(tmpdir(), "workflowy-cli-self-update-"));

  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@workflowy/cli", version: "9.9.9" }));
    expect(readRepoAppVersion(root)).toBe("9.9.9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
