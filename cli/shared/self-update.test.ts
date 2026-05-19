import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findWorkflowyRepoRoot, getSelfUpdateCandidates, isWorkflowyRepoRoot } from "./self-update.ts";

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
