import { loadConfig } from "./config.ts";

export interface AliasMap {
  [name: string]: string;
}

export function getAliases(): AliasMap {
  const config = loadConfig();
  return (config.aliases ?? {}) as AliasMap;
}

export function expandAlias(argv: string[]): string[] {
  if (argv.length <= 2) return argv;

  const aliases = getAliases();
  const commandArg = argv[2];
  if (!commandArg || !(commandArg in aliases)) return argv;

  const expanded = aliases[commandArg]!;
  const parts = expanded.split(/\s+/);

  // Substitute positional args: $1, $2, etc.
  const userArgs = argv.slice(3);
  const resolvedParts = parts.map((p) => {
    const match = p.match(/^\$(\d+)$/);
    if (match) {
      const idx = Number(match[1]) - 1;
      return idx < userArgs.length ? userArgs[idx]! : p;
    }
    return p;
  });

  // Any user args not consumed by positional placeholders get appended
  const usedIndices = new Set<number>();
  for (const p of parts) {
    const match = p.match(/^\$(\d+)$/);
    if (match) usedIndices.add(Number(match[1]) - 1);
  }
  const remaining = userArgs.filter((_, i) => !usedIndices.has(i));

  return [argv[0]!, argv[1]!, ...resolvedParts, ...remaining];
}
