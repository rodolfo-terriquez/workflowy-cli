import { findWorkflowyRepoRoot, getSelfUpdateCandidates } from "./self-update.ts";

export const APP_VERSION = "3.1.9";

export interface VersionInfo {
  appVersion: string;
  gitHead: string | null;
}

export function getRepoGitHead(repoRoot: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) return null;
  const head = new TextDecoder().decode(result.stdout).trim();
  return head.length > 0 ? head : null;
}

export function getRuntimeVersionInfo(
  execPath = process.execPath,
  cwd = process.cwd(),
  argv = process.argv,
  moduleDir = import.meta.dir,
): VersionInfo {
  const repoRoot = findWorkflowyRepoRoot(getSelfUpdateCandidates(execPath, cwd, argv, moduleDir));
  const gitHead = repoRoot ? getRepoGitHead(repoRoot) : null;

  return {
    appVersion: APP_VERSION,
    gitHead,
  };
}
