import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

const PACKAGE_NAME = "@workflowy/cli";
const ABSOLUTE_PATH_RE = /^(\/|[A-Za-z]:[\\/])/;

export interface ParsedProcessCommand {
  pid: number;
  command: string;
  argv: string[];
}

export type McpRestartMode = "restart" | "stop_only";

export function getSelfUpdateCandidates(
  execPath: string,
  cwd: string,
  argv: string[],
  moduleDir: string,
): string[] {
  const candidates = [
    argv[1],
    execPath,
    moduleDir,
    cwd,
  ].filter((value): value is string => !!value);

  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

export function findWorkflowyRepoRoot(candidates: string[]): string | null {
  const visited = new Set<string>();

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) continue;

    for (const dir of walkUp(normalized)) {
      if (visited.has(dir)) continue;
      visited.add(dir);

      if (isWorkflowyRepoRoot(dir)) {
        return dir;
      }
    }
  }

  return null;
}

export function isWorkflowyRepoRoot(dir: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;

  const packageJsonPath = join(dir, "package.json");
  const cliEntryPath = join(dir, "cli", "wf.ts");
  if (!existsSync(packageJsonPath) || !existsSync(cliEntryPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
    return pkg.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

export function splitCommandLine(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

export function parseProcessListLine(line: string): ParsedProcessCommand | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+)\s+(.+)$/);
  if (!match) return null;

  const pid = Number(match[1]);
  const command = match[2]!;
  if (!Number.isFinite(pid) || pid <= 0) return null;

  return {
    pid,
    command,
    argv: splitCommandLine(command),
  };
}

export function findWorkflowyRepoRootFromArgv(argv: string[]): string | null {
  const candidates = argv.filter((arg) => ABSOLUTE_PATH_RE.test(arg));
  return findWorkflowyRepoRoot(candidates);
}

export function getMcpRestartMode(argv: string[]): McpRestartMode | null {
  if (!argv.includes("mcp")) return null;
  return argv.includes("--port") ? "restart" : "stop_only";
}

function normalizeCandidate(candidate: string): string | null {
  try {
    const resolved = realpathSync(candidate);
    return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  } catch {
    return null;
  }
}

function walkUp(startDir: string): string[] {
  const dirs: string[] = [];
  let current = startDir;

  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs;
}
