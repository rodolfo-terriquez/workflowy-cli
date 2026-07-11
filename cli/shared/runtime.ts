interface SelfInvocationOptions {
  agent?: boolean;
  mainPath?: string;
  execPath?: string;
}

export function isBundledRuntime(mainPath = Bun.main): boolean {
  if (!mainPath) return true;

  const normalizedPath = mainPath.replaceAll("\\", "/");
  return /(?:^|\/)(?:\$bunfs|~bun)(?:\/|$)/i.test(normalizedPath);
}

export function getSelfCliInvocation(
  commandArgs: string[],
  options: SelfInvocationOptions = {},
): string[] {
  const mainPath = options.mainPath ?? Bun.main;
  const execPath = options.execPath ?? process.execPath;
  const args = options.agent ? ["--agent", ...commandArgs] : commandArgs;

  if (!isBundledRuntime(mainPath)) {
    return ["bun", "run", mainPath, ...args];
  }

  return [execPath, ...args];
}
