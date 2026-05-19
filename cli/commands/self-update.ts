import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import { findWorkflowyRepoRoot, getSelfUpdateCandidates } from "../shared/self-update.ts";

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function registerSelfUpdate(program: Command): void {
  program
    .command("self:update")
    .description("Pull the latest git-based version and rebuild the binary")
    .option("--check", "Show detected install and repo info without updating")
    .option("--allow-dirty", "Allow update when tracked files are modified")
    .action(async (opts: { check?: boolean; allowDirty?: boolean }) => {
      const repoRoot = findWorkflowyRepoRoot(
        getSelfUpdateCandidates(process.execPath, process.cwd(), process.argv, import.meta.dir),
      );

      if (!repoRoot) {
        exitWithError(
          "update_unsupported",
          "Could not locate a git checkout for this wf install.",
          "Use a repo-based install or update manually from the repository.",
        );
      }

      const branch = await requireCommand(["git", "branch", "--show-current"], repoRoot);
      const upstream = await requireCommand(
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        repoRoot,
        "update_no_upstream",
        "Current branch has no upstream configured.",
      );
      const dirtyTracked = (await requireCommand(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        repoRoot,
      )).trim();
      const currentHead = await requireCommand(["git", "rev-parse", "--short", "HEAD"], repoRoot);
      const targetBinary = join(repoRoot, "dist", "wf");

      if (opts.check) {
        emitStatus({
          repoRoot,
          branch,
          upstream,
          currentHead,
          dirtyTracked: dirtyTracked.length > 0,
          targetBinary,
        });
        return;
      }

      if (dirtyTracked && !opts.allowDirty) {
        exitWithError(
          "update_dirty_worktree",
          "Tracked files are modified in the wf checkout.",
          "Commit, stash, or rerun with `wf self:update --allow-dirty` if you really want to proceed.",
        );
      }

      if (!isAgentMode()) {
        console.log(`\n  ${chalk.dim("Updating from")} ${chalk.cyan(upstream)} ${chalk.dim(`(branch: ${branch})`)}`);
      }

      await requireCommand(["git", "pull", "--ff-only"], repoRoot, "update_pull_failed", "Could not pull latest changes from upstream.");
      const updatedHead = await requireCommand(["git", "rev-parse", "--short", "HEAD"], repoRoot);

      await requireCommand(["bun", "install"], repoRoot, "update_install_failed", "Dependency install failed.");

      const distDir = join(repoRoot, "dist");
      if (!existsSync(distDir)) {
        mkdirSync(distDir, { recursive: true });
      }

      const tempBinary = join(distDir, "wf.next");
      if (existsSync(tempBinary)) {
        rmSync(tempBinary, { force: true });
      }

      await requireCommand(
        ["bun", "build", "cli/wf.ts", "--compile", "--outfile", tempBinary],
        repoRoot,
        "update_build_failed",
        "Binary rebuild failed.",
      );

      renameSync(tempBinary, targetBinary);

      emitUpdated({
        repoRoot,
        branch,
        upstream,
        beforeHead: currentHead,
        afterHead: updatedHead,
        targetBinary,
      });
    });
}

async function runCommand(args: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function requireCommand(
  args: string[],
  cwd: string,
  code = "update_command_failed",
  message?: string,
): Promise<string> {
  const result = await runCommand(args, cwd);
  if (!result.ok) {
    const detail = result.stderr || result.stdout || `Command failed with exit code ${result.exitCode}`;
    exitWithError(code, message ?? detail, detail);
  }
  return result.stdout;
}

function emitStatus(info: {
  repoRoot: string;
  branch: string;
  upstream: string;
  currentHead: string;
  dirtyTracked: boolean;
  targetBinary: string;
}): void {
  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "self:update", mode: "check", wf_version: "3.0.0" },
      ...info,
    }, null, 2));
    return;
  }

  console.log(`\n  ${chalk.bold("wf self:update")} — install check\n`);
  console.log(`  ${chalk.green("✓")} Repo root: ${info.repoRoot}`);
  console.log(`  ${chalk.green("✓")} Branch: ${info.branch}`);
  console.log(`  ${chalk.green("✓")} Upstream: ${info.upstream}`);
  console.log(`  ${chalk.green("✓")} Current HEAD: ${info.currentHead}`);
  console.log(`  ${info.dirtyTracked ? chalk.yellow("⚠") : chalk.green("✓")} Tracked worktree: ${info.dirtyTracked ? "dirty" : "clean"}`);
  console.log(`  ${chalk.green("✓")} Binary target: ${info.targetBinary}\n`);
}

function emitUpdated(info: {
  repoRoot: string;
  branch: string;
  upstream: string;
  beforeHead: string;
  afterHead: string;
  targetBinary: string;
}): void {
  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "self:update", wf_version: "3.0.0" },
      ...info,
      updated: info.beforeHead !== info.afterHead,
    }, null, 2));
    return;
  }

  const changed = info.beforeHead !== info.afterHead;
  console.log(`\n  ${chalk.green("✓")} Update complete`);
  console.log(`  ${chalk.dim("Repo:")} ${info.repoRoot}`);
  console.log(`  ${chalk.dim("Branch:")} ${info.branch} (${info.upstream})`);
  console.log(`  ${chalk.dim("HEAD:")} ${info.beforeHead}${changed ? ` → ${info.afterHead}` : ` (${chalk.dim("already current")})`}`);
  console.log(`  ${chalk.dim("Binary:")} ${info.targetBinary}\n`);
}
