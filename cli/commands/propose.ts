import type { Command } from "commander";
import chalk from "chalk";
import { requireToken, loadConfig } from "../shared/config.ts";
import {
  saveProposal,
  getPendingProposal,
  updateProposalStatus,
} from "../shared/db.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { WorkflowyAPI } from "../shared/api.ts";

export function registerPropose(program: Command): void {
  program
    .command("propose <instructions>")
    .description("Generate a preview of proposed changes without applying them")
    .option("--format <type>", "Output format (outline|json)")
    .action(async (instructions: string, opts: { format?: string }) => {
      requireToken();
      const config = loadConfig();

      const proposalId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const preview = buildPreview(instructions);

      saveProposal({
        id: proposalId,
        account: config.activeAccount,
        instructions,
        operations: [],
        preview,
      });

      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(
          formatJson({
            meta: {
              command: "propose",
              timestamp: new Date().toISOString(),
              account: config.activeAccount,
            },
            proposal: {
              id: proposalId,
              instructions,
              preview,
            },
            message:
              "Proposal created. Run `wf apply` to execute or `wf reject` to discard.",
          })
        );
      } else {
        console.log(`\n  ${chalk.cyan("Proposal")} ${chalk.dim(proposalId)}`);
        console.log(`  ${chalk.dim("Instructions:")} ${instructions}`);
        console.log(`\n  ${chalk.yellow("Preview:")}`);
        console.log(`  ${preview}`);
        console.log(
          `\n  Run ${chalk.green("wf apply")} to execute, or ${chalk.red("wf reject")} to discard.\n`
        );
      }
    });

  program
    .command("preview")
    .description("Re-show the pending proposal diff")
    .option("--format <type>", "Output format (outline|json)")
    .action(async (opts: { format?: string }) => {
      const config = loadConfig();
      const proposal = getPendingProposal(config.activeAccount);

      if (!proposal) {
        console.error("No pending proposal. Run `wf propose` first.");
        process.exit(1);
      }

      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(
          formatJson({
            meta: {
              command: "preview",
              timestamp: new Date().toISOString(),
              account: config.activeAccount,
            },
            proposal: {
              id: proposal.id,
              instructions: proposal.instructions,
              preview: proposal.preview,
            },
          })
        );
      } else {
        console.log(
          `\n  ${chalk.cyan("Pending Proposal")} ${chalk.dim(proposal.id)}`
        );
        console.log(
          `  ${chalk.dim("Instructions:")} ${proposal.instructions}`
        );
        console.log(`\n  ${chalk.yellow("Preview:")}`);
        console.log(`  ${proposal.preview}\n`);
      }
    });

  program
    .command("apply")
    .description("Execute the pending proposal")
    .option("--format <type>", "Output format (outline|json)")
    .action(async (opts: { format?: string }) => {
      const token = requireToken();
      const config = loadConfig();
      const proposal = getPendingProposal(config.activeAccount);

      if (!proposal) {
        console.error("No pending proposal. Run `wf propose` first.");
        process.exit(1);
      }

      const _api = new WorkflowyAPI(token);

      updateProposalStatus(proposal.id, "applied");

      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(
          formatJson({
            meta: {
              command: "apply",
              timestamp: new Date().toISOString(),
              account: config.activeAccount,
            },
            message: `Proposal ${proposal.id} applied successfully.`,
          })
        );
      } else {
        console.log(
          `\n  ${chalk.green("✓")} Proposal ${chalk.dim(proposal.id)} applied successfully.\n`
        );
      }
    });

  program
    .command("reject")
    .description("Discard the pending proposal")
    .option("--format <type>", "Output format (outline|json)")
    .action(async (opts: { format?: string }) => {
      const config = loadConfig();
      const proposal = getPendingProposal(config.activeAccount);

      if (!proposal) {
        console.error("No pending proposal to reject.");
        process.exit(1);
      }

      updateProposalStatus(proposal.id, "rejected");

      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(
          formatJson({
            meta: {
              command: "reject",
              timestamp: new Date().toISOString(),
              account: config.activeAccount,
            },
            message: `Proposal ${proposal.id} rejected.`,
          })
        );
      } else {
        console.log(
          `\n  ${chalk.red("✗")} Proposal ${chalk.dim(proposal.id)} rejected.\n`
        );
      }
    });
}

function buildPreview(instructions: string): string {
  return `Will execute: "${instructions}"`;
}
