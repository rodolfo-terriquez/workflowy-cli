import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { homedir, platform } from "os";
import { getConfigDir, loadConfig, getDbPath } from "../shared/config.ts";
import { getCacheNodeCount, getCacheAgeSeconds } from "../shared/cache.ts";
import { isAgentMode } from "../agent.ts";
import { join } from "path";
import { getRuntimeVersionInfo } from "../shared/version.ts";

const VERSION = getRuntimeVersionInfo().version;

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getWatchDaemonStatus(): { ok: boolean; detail: string } {
  const watchPidPath = join(getConfigDir(), "watch.pid");
  if (!existsSync(watchPidPath)) {
    return { ok: true, detail: "not running" };
  }

  const rawPid = readFileSync(watchPidPath, "utf-8").trim();
  const pid = Number(rawPid);
  if (!rawPid || Number.isNaN(pid)) {
    return { ok: false, detail: "invalid PID file" };
  }

  if (!isProcessRunning(pid)) {
    return { ok: false, detail: `stale PID file (${pid} is not running)` };
  }

  return { ok: true, detail: `running (PID ${pid})` };
}

function detectShell(): "bash" | "zsh" | "fish" {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}

function getShellCompletionsStatus(): { ok: boolean; detail: string; warn?: boolean } {
  const home = homedir();
  const shell = detectShell();

  if (shell === "zsh") {
    const scriptPath = join(home, ".zsh", "completions", "_wf");
    const zshrcPath = join(home, ".zshrc");
    const scriptExists = existsSync(scriptPath);
    const initConfigured = existsSync(zshrcPath)
      && readFileSync(zshrcPath, "utf-8").includes("fpath=(~/.zsh/completions");

    if (scriptExists && initConfigured) {
      return { ok: true, detail: `installed for zsh (${scriptPath})` };
    }

    if (scriptExists) {
      return { ok: false, detail: `completion script exists but ~/.zshrc is not configured (${scriptPath})`, warn: true };
    }

    return { ok: true, detail: "not installed — run `wf completions install --shell zsh`", warn: true };
  }

  if (shell === "fish") {
    const scriptPath = join(home, ".config", "fish", "completions", "wf.fish");
    if (existsSync(scriptPath)) {
      return { ok: true, detail: `installed for fish (${scriptPath})` };
    }
    return { ok: true, detail: "not installed — run `wf completions install --shell fish`", warn: true };
  }

  const scriptPath = join(home, ".local", "share", "bash-completion", "completions", "wf");
  const bashrcPath = join(home, ".bashrc");
  const scriptExists = existsSync(scriptPath);
  const initConfigured = existsSync(bashrcPath)
    && readFileSync(bashrcPath, "utf-8").includes(scriptPath);

  if (scriptExists && initConfigured) {
    return { ok: true, detail: `installed for bash (${scriptPath})` };
  }

  if (scriptExists) {
    return { ok: false, detail: `completion script exists but ~/.bashrc is not configured (${scriptPath})`, warn: true };
  }

  return { ok: true, detail: "not installed — run `wf completions install --shell bash`", warn: true };
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose common setup issues")
    .action(async () => {
      const checks: CheckResult[] = [];

      checks.push({ label: "Binary version", ok: true, detail: VERSION });

      const config = loadConfig();
      const hasToken = !!config.accounts[config.activeAccount]?.token;
      checks.push({ label: "Auth token present", ok: hasToken, detail: hasToken ? "yes" : "missing — run `wf login`" });

      if (hasToken) {
        try {
          const start = Date.now();
          const res = await fetch("https://beta.workflowy.com/api/llm/doc/read/inbox/?depth=0", {
            headers: { Authorization: `Bearer ${config.accounts[config.activeAccount]!.token}` },
          });
          const elapsed = Date.now() - start;
          checks.push({
            label: "API reachable (beta.workflowy.com)",
            ok: res.ok,
            detail: res.ok ? `${elapsed}ms` : `HTTP ${res.status}`,
          });
        } catch (err) {
          checks.push({ label: "API reachable", ok: false, detail: String(err) });
        }
      }

      const nodeCount = getCacheNodeCount();
      const cacheAge = getCacheAgeSeconds();
      const dbPath = getDbPath();
      const dbExists = existsSync(dbPath);
      const ageStr = cacheAge ? `${Math.floor(cacheAge / 60)}m old` : "never synced";
      checks.push({
        label: "SQLite DB",
        ok: dbExists && nodeCount > 0,
        detail: dbExists ? `${nodeCount.toLocaleString()} nodes, ${ageStr}` : "missing — run `wf cache:sync`",
      });

      checks.push({ label: "FTS index present", ok: dbExists, detail: dbExists ? "yes" : "no" });

      const llmModel = config.llm?.model ?? "google/gemini-flash-2.5";
      const llmKey = config.llm?.apiKey;
      checks.push({
        label: "LLM config",
        ok: true,
        detail: config.llm ? `configured (model: ${llmModel})` : `not configured (default model: ${llmModel})`,
      });
      checks.push({
        label: "LLM API key",
        ok: !!llmKey,
        detail: llmKey ? "present" : "missing — set with `wf config:set llm.apiKey <key>`",
      });

      const os = platform();
      const clipTool = os === "darwin" ? "pbcopy" : os === "win32" ? "clip" : "xclip";
      let clipOk = false;
      try {
        const proc = Bun.spawn(["which", clipTool], { stdout: "pipe" });
        await proc.exited;
        clipOk = proc.exitCode === 0;
      } catch {
        clipOk = false;
      }
      checks.push({ label: `Clipboard tool: ${clipTool}`, ok: clipOk, detail: clipOk ? "found" : "not found", warn: !clipOk });

      const watchStatus = getWatchDaemonStatus();
      checks.push({ label: "Watch daemon", ok: watchStatus.ok, detail: watchStatus.detail, warn: !watchStatus.ok });

      const completionsStatus = getShellCompletionsStatus();
      checks.push({ label: "Shell completions", ok: completionsStatus.ok, detail: completionsStatus.detail, warn: completionsStatus.warn });

      const hasErrors = checks.some((c) => !c.ok);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "doctor", timestamp: new Date().toISOString(), wf_version: VERSION },
          checks: checks.map((c) => ({ label: c.label, ok: c.ok, detail: c.detail, warn: c.warn })),
          healthy: !hasErrors,
        }, null, 2));
      } else {
        console.log(`\n  ${chalk.bold("wf doctor")} — checking your setup\n`);
        for (const c of checks) {
          const icon = !c.ok ? chalk.red("✗") : c.warn ? chalk.yellow("⚠") : chalk.green("✓");
          console.log(`  ${icon} ${c.label}: ${c.detail}`);
        }
        console.log("");
      }

      process.exit(hasErrors ? 1 : 0);
    });
}
