import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";
import {
  findWorkflowyRepoRoot,
  findWorkflowyRepoRootFromArgv,
  getMcpRestartMode,
  getSelfUpdateCandidates,
  parseProcessListLine,
  readRepoAppVersion,
  type McpRestartMode,
} from "../shared/self-update.ts";
import { APP_VERSION } from "../shared/version.ts";

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ManagedMcpProcess {
  pid: number;
  command: string;
  argv: string[];
  restartMode: McpRestartMode;
}

interface McpRestartSummary {
  restarted: ManagedMcpProcess[];
  stoppedOnly: ManagedMcpProcess[];
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
      const repoAppVersion = readRepoAppVersion(repoRoot) ?? APP_VERSION;

      if (opts.check) {
        emitStatus({
          repoRoot,
          branch,
          upstream,
          currentHead,
          appVersion: repoAppVersion,
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

      const runningMcp = await listManagedMcpProcesses(repoRoot);
      if (runningMcp.length > 0 && !isAgentMode()) {
        console.log(`  ${chalk.dim("MCP:")} stopping ${runningMcp.length} running process${runningMcp.length === 1 ? "" : "es"} before update`);
      }
      await stopManagedMcpProcesses(runningMcp);

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

      const mcpSummary = restartManagedMcpProcesses(runningMcp, repoRoot);
      const updatedAppVersion = readRepoAppVersion(repoRoot) ?? repoAppVersion;

      emitUpdated({
        repoRoot,
        branch,
        upstream,
        beforeHead: currentHead,
        afterHead: updatedHead,
        appVersion: updatedAppVersion,
        targetBinary,
        mcpRestarted: mcpSummary.restarted.length,
        mcpStoppedOnly: mcpSummary.stoppedOnly.length,
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
  appVersion: string;
  dirtyTracked: boolean;
  targetBinary: string;
}): void {
  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "self:update", mode: "check", wf_version: "3.1.11" },
      ...info,
    }, null, 2));
    return;
  }

  console.log(`\n  ${chalk.bold("wf self:update")} — install check\n`);
  console.log(`  ${chalk.green("✓")} Version: ${info.appVersion}`);
  console.log(`  ${chalk.green("✓")} Git HEAD: ${info.currentHead}`);
  console.log(`  ${chalk.green("✓")} Repo root: ${info.repoRoot}`);
  console.log(`  ${chalk.green("✓")} Branch: ${info.branch}`);
  console.log(`  ${chalk.green("✓")} Upstream: ${info.upstream}`);
  console.log(`  ${info.dirtyTracked ? chalk.yellow("⚠") : chalk.green("✓")} Tracked worktree: ${info.dirtyTracked ? "dirty" : "clean"}`);
  console.log(`  ${chalk.green("✓")} Binary target: ${info.targetBinary}\n`);
}

function emitUpdated(info: {
  repoRoot: string;
  branch: string;
  upstream: string;
  beforeHead: string;
  afterHead: string;
  appVersion: string;
  targetBinary: string;
  mcpRestarted: number;
  mcpStoppedOnly: number;
}): void {
  if (isAgentMode()) {
    console.log(JSON.stringify({
      meta: { command: "self:update", wf_version: "3.1.11" },
      ...info,
      updated: info.beforeHead !== info.afterHead,
    }, null, 2));
    return;
  }

  const changed = info.beforeHead !== info.afterHead;
  console.log(`\n  ${chalk.green("✓")} Update complete`);
  console.log(`  ${chalk.dim("Version:")} ${info.appVersion}`);
  console.log(`  ${chalk.dim("Repo:")} ${info.repoRoot}`);
  console.log(`  ${chalk.dim("Branch:")} ${info.branch} (${info.upstream})`);
  console.log(`  ${chalk.dim("HEAD:")} ${info.beforeHead}${changed ? ` → ${info.afterHead}` : ` (${chalk.dim("already current")})`}`);
  console.log(`  ${chalk.dim("Binary:")} ${info.targetBinary}\n`);

  if (info.mcpRestarted > 0 || info.mcpStoppedOnly > 0) {
    console.log(`  ${chalk.dim("MCP restarted:")} ${info.mcpRestarted}`);
    console.log(`  ${chalk.dim("MCP stopped (stdio):")} ${info.mcpStoppedOnly}\n`);
  }
}

async function listManagedMcpProcesses(repoRoot: string): Promise<ManagedMcpProcess[]> {
  if (process.platform === "win32") return [];

  const result = await runCommand(["ps", "-Ao", "pid=,command="], repoRoot);
  if (!result.ok) return [];

  const processes: ManagedMcpProcess[] = [];

  for (const line of result.stdout.split("\n")) {
    const parsed = parseProcessListLine(line);
    if (!parsed || parsed.pid === process.pid) continue;

    const restartMode = getMcpRestartMode(parsed.argv);
    if (!restartMode) continue;

    const processRepoRoot = findWorkflowyRepoRootFromArgv(parsed.argv);
    if (processRepoRoot !== repoRoot) continue;

    processes.push({
      pid: parsed.pid,
      command: parsed.command,
      argv: parsed.argv,
      restartMode,
    });
  }

  return processes;
}

async function stopManagedMcpProcesses(processes: ManagedMcpProcess[]): Promise<void> {
  for (const proc of processes) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      continue;
    }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!isPidRunning(proc.pid)) break;
      await Bun.sleep(100);
    }

    if (isPidRunning(proc.pid)) {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // Ignore race with process exit.
      }
    }
  }
}

function restartManagedMcpProcesses(processes: ManagedMcpProcess[], repoRoot: string): McpRestartSummary {
  const summary: McpRestartSummary = { restarted: [], stoppedOnly: [] };

  for (const proc of processes) {
    if (proc.restartMode === "restart") {
      const child = Bun.spawn(proc.argv, {
        cwd: repoRoot,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: process.env,
      });
      child.unref();
      summary.restarted.push(proc);
    } else {
      summary.stoppedOnly.push(proc);
    }
  }

  return summary;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
