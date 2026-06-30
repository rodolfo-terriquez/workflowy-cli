import * as readline from "node:readline";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { getConfigDir } from "./config.ts";
import { getCacheDb, getCacheNodeCount } from "./cache.ts";
import { expandAlias } from "./alias.ts";

const HISTORY_PATH = join(getConfigDir(), "history");
const MAX_HISTORY = 500;

const ALL_COMMANDS = [
  "read", "add", "move", "complete", "update", "delete", "find", "context", "todos", "bulk", "template", "export",
  "node:read", "node:add", "node:move", "node:complete", "node:update", "node:delete",
  "node:find", "node:context", "node:todos", "node:template", "node:export",
  "node:bulk complete", "node:bulk delete", "node:bulk move",
  "search", "tags", "targets", "bookmark:list", "bookmark:save", "bookmarks", "history",
  "sync", "cache:sync", "cache:diff",
  "ai:propose", "ai:preview", "ai:apply", "ai:reject", "ai:list",
  "batch",
  "config:set", "config:get", "config:alias",
  "account:list", "account:switch", "account:current",
  "watch:start", "watch:stop", "watch:status",
  "webhook:create", "webhook:list", "webhook:delete", "webhook:test",
  "workflow:run", "workflow:list", "workflow:create",
  "mcp", "doctor", "status", "completions", "login", "self:update",
  "exit", "quit", "help",
];

const FORMAT_OPTIONS = ["json", "outline", "tsv", "csv"];

const TARGET_SLUGS = [
  "@inbox", "@today", "@tomorrow", "@calendar", "@next-week",
];

function loadHistory(): string[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return readFileSync(HISTORY_PATH, "utf-8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendHistory(line: string): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(HISTORY_PATH, line + "\n");
}

function trimHistoryFile(): void {
  const lines = loadHistory();
  if (lines.length > MAX_HISTORY) {
    writeFileSync(HISTORY_PATH, lines.slice(-MAX_HISTORY).join("\n") + "\n");
  }
}

function getCachedNodeNames(limit = 50): string[] {
  try {
    if (getCacheNodeCount() === 0) return [];
    const db = getCacheDb();
    const rows = db.query(
      "SELECT name FROM nodes WHERE name != '' AND parent_id IS NULL ORDER BY priority LIMIT ?"
    ).all(limit) as Array<{ name: string }>;
    return rows.map((r) => r.name.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function isBundledRuntime(): boolean {
  return import.meta.dir.startsWith("/$bunfs/") || import.meta.dir.includes("$bunfs");
}

function buildReplCommand(cmdTokens: string[]): string[] {
  if (isBundledRuntime()) {
    return [process.execPath, ...cmdTokens];
  }

  return ["bun", "run", join(import.meta.dir, "../wf.ts"), ...cmdTokens];
}

function printReplHelp(): void {
  const c = chalk.hex("#47b8f5");
  const dim = chalk.dim;

  console.log(dim("\n  Common commands:\n"));
  const rows: Array<[string, string]> = [
    ["read @demo --depth 2", "Read a node and its children"],
    ["add @inbox \"Quick note\"", "Add a child node"],
    ["search video --target @youtube", "Search, optionally scoped to a subtree"],
    ["find \"Project name\"", "Find nodes by name or path"],
    ["todos --target @today", "List open todos"],
    ["sync", "Refresh the local cache"],
    ["targets", "List saved @targets"],
    ["ai:propose \"...\"", "Preview an AI-generated edit"],
    ["exit", "Leave interactive mode"],
  ];

  for (const [cmd, desc] of rows) {
    console.log(`  ${c(cmd.padEnd(32))} ${dim(desc)}`);
  }

  console.log(dim("\n  Tip: inside this shell, omit the leading `wf`. Full names like node:add still work.\n"));
}

function completer(line: string): [string[], string] {
  const trimmed = line.trimStart();
  const parts = trimmed.split(/\s+/);

  // Completing the command itself (first word)
  if (parts.length <= 1) {
    const matches = ALL_COMMANDS.filter((c) => c.startsWith(trimmed));
    return [matches, trimmed];
  }

  const lastPart = parts[parts.length - 1]!;
  const prevPart = parts.length >= 2 ? parts[parts.length - 2] : "";

  // After --format, complete format options
  if (prevPart === "--format") {
    const matches = FORMAT_OPTIONS.filter((f) => f.startsWith(lastPart));
    return [matches, lastPart];
  }

  // After --to or as a target argument, complete @targets + top-level node names
  if (lastPart.startsWith("@")) {
    const matches = TARGET_SLUGS.filter((t) => t.startsWith(lastPart));
    return [matches, lastPart];
  }

  // After commands that take a target argument, offer @targets
  const cmd = parts[0]!;
  const targetCommands = ["read", "add", "find", "context", "move", "export", "node:read", "node:add", "node:find", "node:context", "node:move", "node:export"];
  if (targetCommands.includes(cmd) && parts.length === 2) {
    const allTargets = [...TARGET_SLUGS, ...getCachedNodeNames(20)];
    const matches = allTargets.filter((t) => t.toLowerCase().startsWith(lastPart.toLowerCase()));
    return [matches.length > 0 ? matches : allTargets.slice(0, 10), lastPart];
  }

  // After --to, offer targets
  if (prevPart === "--to") {
    const matches = TARGET_SLUGS.filter((t) => t.startsWith(lastPart));
    return [matches.length > 0 ? matches : TARGET_SLUGS, lastPart];
  }

  // Flag completions
  if (lastPart.startsWith("--")) {
    const commonFlags = ["--format", "--copy", "--live", "--limit", "--target", "--to", "--agent"];
    const matches = commonFlags.filter((f) => f.startsWith(lastPart));
    return [matches, lastPart];
  }

  return [[], lastPart];
}

export async function startRepl(): Promise<void> {
  const history = loadHistory();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.hex("#47b8f5")("wf> "),
    completer,
    terminal: true,
    history,
    historySize: MAX_HISTORY,
  });

  console.log(chalk.dim("  Type a command, Tab to autocomplete, Ctrl+R to search history, 'exit' to quit.\n"));

  rl.prompt();

  rl.on("line", async (rawLine: string) => {
    const line = rawLine.trim();

    if (!line) {
      rl.prompt();
      return;
    }

    if (line === "exit" || line === "quit") {
      console.log(chalk.dim("\n  Goodbye.\n"));
      trimHistoryFile();
      rl.close();
      process.exit(0);
    }

    if (line === "help") {
      printReplHelp();
      rl.prompt();
      return;
    }

    appendHistory(line);

    // Parse the line into argv-style tokens (handles quoted strings)
    const tokens = tokenize(line);
    const fakeArgv = ["bun", "wf.ts", ...tokens];
    const expanded = expandAlias(fakeArgv);
    const cmdTokens = expanded.slice(2);

    try {
      const proc = Bun.spawn(buildReplCommand(cmdTokens), {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, FORCE_COLOR: "1" },
      });
      await proc.exited;
    } catch (err) {
      console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
    }

    rl.prompt();
  });

  rl.on("close", () => {
    trimHistoryFile();
    process.exit(0);
  });
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}
