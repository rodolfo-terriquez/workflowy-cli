import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

const PACKAGE_NAME = "@workflowy/cli";

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
