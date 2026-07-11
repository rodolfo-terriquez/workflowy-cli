import { APP_VERSION } from "../shared/version.ts";
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getAccountStorageKey, getActiveAccountName, getConfigDir } from "../shared/config.ts";
import type { Proposal } from "../shared/propose.ts";
import { isAgentMode } from "../agent.ts";

function getProposalsDir(): string {
  return join(getConfigDir(), "proposals", getAccountStorageKey(getActiveAccountName()));
}

function listPendingProposals(): Proposal[] {
  const proposalsDir = getProposalsDir();
  if (!existsSync(proposalsDir)) return [];
  const files = readdirSync(proposalsDir).filter((f) => f.endsWith(".json"));
  const proposals: Proposal[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(proposalsDir, f), "utf-8")) as Proposal;
      proposals.push(data);
    } catch {
      // skip
    }
  }
  return proposals.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export function registerProposalsList(program: Command): void {
  program
    .command("ai:list")
    .description("List all pending proposals")
    .option("--format <type>", "Output format (outline|json)")
    .action((opts: { format?: string }) => {
      const proposals = listPendingProposals();
      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(JSON.stringify({
          meta: { command: "ai:list", timestamp: new Date().toISOString(), account: getActiveAccountName(), wf_version: APP_VERSION },
          proposals: proposals.map((p) => ({
            id: p.id,
            summary: p.summary,
            instruction: p.instruction,
            operation_count: p.operations.length,
            created_at: p.created_at,
          })),
          count: proposals.length,
        }, null, 2));
        return;
      }

      if (proposals.length === 0) {
        console.log(chalk.dim("\n  No pending proposals.\n"));
        return;
      }

      console.log(`\n  ${proposals.length} pending proposal${proposals.length !== 1 ? "s" : ""}:\n`);
      for (const p of proposals) {
        console.log(`  ${chalk.cyan(p.id)}  ${p.summary}`);
        console.log(`  ${chalk.dim(p.instruction)}  ${chalk.dim(p.created_at)}\n`);
      }
    });
}
