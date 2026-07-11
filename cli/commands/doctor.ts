import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { homedir, platform } from "os";
import { getAccountCacheDbPath, getAccountStorageKey, getActiveAccountName, getConfigDir, loadConfig } from "../shared/config.ts";
import { getCacheNodeCount, getCacheAgeSeconds } from "../shared/cache.ts";
import { isAgentMode } from "../agent.ts";
import { join } from "path";
import { getRuntimeVersionInfo } from "../shared/version.ts";
import { describeLlmConfig } from "../shared/llm.ts";

const VERSION = getRuntimeVersionInfo().appVersion;

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

interface ApiStatus {
  checked: boolean;
  reachable: boolean;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

interface DoctorReport {
  meta: {
    command: "doctor";
    timestamp: string;
    wf_version: string;
  };
  checks: Array<{ label: string; ok: boolean; detail: string; warn?: boolean }>;
  healthy: boolean;
  ready: boolean;
  account: {
    active: string;
    configured: boolean;
  };
  auth: {
    token_present: boolean;
    valid: boolean;
  };
  api: ApiStatus;
  cache: {
    db_exists: boolean;
    present: boolean;
    node_count: number;
    cache_age_seconds: number | null;
    cache_stale: boolean;
  };
  suggested_actions: string[];
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
  const watchPidPath = join(getConfigDir(), `watch-${getAccountStorageKey(getActiveAccountName())}.pid`);
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

async function getApiStatus(token: string | undefined): Promise<ApiStatus> {
  if (!token) {
    return {
      checked: false,
      reachable: false,
      ok: false,
      status_code: null,
      latency_ms: null,
      error: null,
    };
  }

  try {
    const start = Date.now();
    const res = await fetch("https://beta.workflowy.com/api/llm/doc/read/inbox/?depth=0", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    return {
      checked: true,
      reachable: true,
      ok: res.ok,
      status_code: res.status,
      latency_ms: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      checked: true,
      reachable: false,
      ok: false,
      status_code: null,
      latency_ms: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildSuggestedActions(report: Omit<DoctorReport, "suggested_actions">): string[] {
  const suggestions = new Set<string>();

  if (!report.auth.token_present || !report.auth.valid) {
    suggestions.add("wf login");
  }

  if (!report.cache.present || report.cache.cache_stale) {
    suggestions.add("wf sync");
  }

  if (!report.ready) {
    suggestions.add("wf status");
  }

  return [...suggestions];
}

export async function collectDoctorReport(): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  checks.push({ label: "Binary version", ok: true, detail: VERSION });

  const config = loadConfig();
  const activeAccount = getActiveAccountName(config);
  const token = config.accounts[activeAccount]?.token;
  const hasToken = !!token;
  checks.push({ label: "Auth token present", ok: hasToken, detail: hasToken ? "yes" : "missing — run `wf login`" });

  const apiStatus = await getApiStatus(token);
  if (hasToken) {
    checks.push({
      label: "API reachable (beta.workflowy.com)",
      ok: apiStatus.ok,
      detail: apiStatus.reachable
        ? apiStatus.ok
          ? `${apiStatus.latency_ms}ms`
          : `HTTP ${apiStatus.status_code}`
        : apiStatus.error ?? "unreachable",
    });
  }

  const nodeCount = getCacheNodeCount();
  const cacheAge = getCacheAgeSeconds();
  const dbPath = getAccountCacheDbPath(activeAccount);
  const dbExists = existsSync(dbPath);
  const cachePresent = dbExists && nodeCount > 0;
  const cacheStale = cacheAge === null || cacheAge > 300;
  const ageStr = cacheAge ? `${Math.floor(cacheAge / 60)}m old` : "never synced";
  checks.push({
    label: "SQLite DB",
    ok: cachePresent,
    detail: dbExists ? `${nodeCount.toLocaleString()} nodes, ${ageStr}` : "missing — run `wf cache:sync`",
  });

  checks.push({ label: "FTS index present", ok: dbExists, detail: dbExists ? "yes" : "no" });

  const llmStatus = describeLlmConfig(config.llm);
  const llmKey = config.llm?.apiKey;
  checks.push({
    label: "LLM config",
    ok: !llmStatus.error,
    detail: llmStatus.error
      ? llmStatus.error
      : config.llm
        ? `configured (provider: ${llmStatus.provider}, model: ${llmStatus.model})`
        : `not configured (default provider: ${llmStatus.provider}, default model: ${llmStatus.model})`,
    warn: !!llmStatus.error,
  });
  checks.push({
    label: "LLM API key",
    ok: true,
    detail: llmKey ? "present" : "missing — set securely with `printf %s \"$LLM_API_KEY\" | wf config:set llm.apiKey --stdin`",
    warn: !llmKey,
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

  const hasErrors = checks.some((c) => !c.ok && !c.warn);
  const reportBase = {
    meta: {
      command: "doctor" as const,
      timestamp: new Date().toISOString(),
      wf_version: VERSION,
    },
    checks: checks.map((c) => ({ label: c.label, ok: c.ok, detail: c.detail, warn: c.warn })),
    healthy: !hasErrors,
    ready: hasToken && apiStatus.ok,
    account: {
      active: activeAccount,
      configured: !!config.accounts[activeAccount],
    },
    auth: {
      token_present: hasToken,
      valid: hasToken && apiStatus.ok,
    },
    api: apiStatus,
    cache: {
      db_exists: dbExists,
      present: cachePresent,
      node_count: nodeCount,
      cache_age_seconds: cacheAge,
      cache_stale: cacheStale,
    },
  };

  return {
    ...reportBase,
    suggested_actions: buildSuggestedActions(reportBase),
  };
}

export async function runDoctor(): Promise<void> {
  const report = await collectDoctorReport();

  if (isAgentMode()) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n  ${chalk.bold("wf doctor")} — checking your setup\n`);
    for (const c of report.checks) {
      const icon = c.warn ? chalk.yellow("⚠") : !c.ok ? chalk.red("✗") : chalk.green("✓");
      console.log(`  ${icon} ${c.label}: ${c.detail}`);
    }

    const summary = report.ready ? chalk.green("ready") : chalk.yellow("not ready");
    console.log(`  ${chalk.bold("Ready:")} ${summary}`);
    if (report.suggested_actions.length > 0) {
      console.log(`  ${chalk.bold("Next:")}  ${report.suggested_actions.join("  ·  ")}`);
    }
    console.log("");
  }

  process.exit(report.healthy ? 0 : 1);
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .alias("status")
    .description("Diagnose common setup issues")
    .action(runDoctor);
}
