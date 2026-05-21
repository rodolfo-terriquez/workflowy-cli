import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { WorkflowyAPI, type LlmDocOperation } from "../shared/api.ts";
import { requireToken, loadConfig, getConfigDir } from "../shared/config.ts";
import { generateProposal, type Proposal, type ProposalOperation } from "../shared/propose.ts";
import { getCacheAgeSeconds, isCacheStale, markTargetDirty } from "../shared/cache.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

const PROPOSALS_DIR = join(getConfigDir(), "proposals");

function ensureProposalsDir(): void {
  if (!existsSync(PROPOSALS_DIR)) {
    mkdirSync(PROPOSALS_DIR, { recursive: true });
  }
}

function getProposalPath(id: string): string {
  return join(PROPOSALS_DIR, `${id}.json`);
}

function loadProposal(id: string): Proposal | null {
  const path = getProposalPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Proposal;
  } catch {
    return null;
  }
}

function listPendingProposals(): Proposal[] {
  ensureProposalsDir();
  const files = readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json"));
  const proposals: Proposal[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(PROPOSALS_DIR, f), "utf-8")) as Proposal;
      proposals.push(data);
    } catch {
      // skip invalid files
    }
  }
  return proposals.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

function saveProposalFile(proposal: Proposal): void {
  ensureProposalsDir();
  writeFileSync(getProposalPath(proposal.id), JSON.stringify(proposal, null, 2), "utf-8");
}

function deleteProposalFile(id: string): void {
  const path = getProposalPath(id);
  if (existsSync(path)) unlinkSync(path);
}

export function registerAiCommands(program: Command): void {
  program
    .command("ai:propose <instructions>")
    .description("Generate a preview of proposed changes using an LLM")
    .option("--format <type>", "Output format (outline|json)")
    .option("--model <id>", "Override LLM model for this call")
    .action(async (instructions: string, opts: { format?: string; model?: string }) => {
      requireToken();
      const config = loadConfig();

      if (!isAgentMode()) process.stdout.write(chalk.dim("  Generating proposal..."));

      let result: { summary: string; operations: ProposalOperation[] };
      try {
        result = await generateProposal(instructions, opts.model);
      } catch (err) {
        if (!isAgentMode()) process.stdout.write("\r");
        exitWithError(
          "llm_error",
          err instanceof Error ? err.message : String(err),
          "Check your LLM API key with `wf config:get llm.apiKey`"
        );
      }

      const proposalId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

      const proposal: Proposal = {
        id: proposalId,
        summary: result.summary,
        instruction: instructions,
        operations: result.operations,
        created_at: new Date().toISOString(),
      };

      saveProposalFile(proposal);

      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(JSON.stringify({
          meta: {
            command: "ai:propose",
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.0.2",
          },
          proposal: {
            id: proposalId,
            summary: result.summary,
            operation_count: result.operations.length,
            operations: result.operations,
          },
        }, null, 2));
      } else {
        process.stdout.write("\r");
        console.log(`  ${chalk.cyan("Proposal")} ${chalk.dim(proposalId)} — "${instructions}"\n`);
        console.log(`  ${chalk.bold(result.summary)}\n`);
        console.log(`  Changes (${result.operations.length} operation${result.operations.length !== 1 ? "s" : ""}):\n`);

        for (let i = 0; i < result.operations.length; i++) {
          const op = result.operations[i]!;
          const isLast = i === result.operations.length - 1;
          const connector = isLast ? "└─" : "├─";
          console.log(`  ${connector} ${formatOpDescription(op)}`);
        }

        console.log(`\n  Run ${chalk.green("wf ai:apply " + proposalId)} to execute, or ${chalk.red("wf ai:reject " + proposalId)} to discard.\n`);
      }
    });

  program
    .command("ai:preview [id]")
    .description("Re-show a pending proposal diff")
    .option("--format <type>", "Output format (outline|json)")
    .action((id: string | undefined, opts: { format?: string }) => {
      const config = loadConfig();
      let proposal: Proposal | null;

      if (id) {
        proposal = loadProposal(id);
      } else {
        const all = listPendingProposals();
        proposal = all[0] ?? null;
      }

      if (!proposal) {
        exitWithError("no_proposal", "No pending proposal found.", "Run `wf ai:propose` first.");
      }

      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(JSON.stringify({
          meta: { command: "ai:preview", timestamp: new Date().toISOString(), account: config.activeAccount, wf_version: "3.0.2" },
          proposal: {
            id: proposal.id,
            summary: proposal.summary,
            instruction: proposal.instruction,
            operation_count: proposal.operations.length,
            operations: proposal.operations,
          },
        }, null, 2));
      } else {
        console.log(`\n  ${chalk.cyan("Pending Proposal")} ${chalk.dim(proposal.id)}`);
        console.log(`  ${chalk.dim("Instruction:")} ${proposal.instruction}\n`);
        console.log(`  ${chalk.bold(proposal.summary)}\n`);

        for (let i = 0; i < proposal.operations.length; i++) {
          const op = proposal.operations[i]!;
          const isLast = i === proposal.operations.length - 1;
          console.log(`  ${isLast ? "└─" : "├─"} ${formatOpDescription(op)}`);
        }
        console.log("");
      }
    });

  program
    .command("ai:apply [id]")
    .description("Execute a pending proposal")
    .option("--format <type>", "Output format (outline|json)")
    .option("--all", "Apply all pending proposals in order")
    .action(async (id: string | undefined, opts: { format?: string; all?: boolean }) => {
      const token = requireToken();
      const config = loadConfig();
      const api = new WorkflowyAPI(token);

      let proposals: Proposal[];

      if (opts.all) {
        proposals = listPendingProposals();
        if (proposals.length === 0) {
          exitWithError("no_proposal", "No pending proposals.", "Run `wf ai:propose` first.");
        }
      } else {
        let proposal: Proposal | null;
        if (id) {
          proposal = loadProposal(id);
        } else {
          const all = listPendingProposals();
          proposal = all[0] ?? null;
        }
        if (!proposal) {
          exitWithError("no_proposal", "No pending proposal found.", "Run `wf ai:propose` first.");
        }
        proposals = [proposal];
      }

      for (const proposal of proposals) {
        const grouped = groupOperationsByRoot(proposal.operations);
        let totalApiCalls = 0;
        const errors: string[] = [];

        for (const [root, ops] of grouped) {
          try {
            await api.readDoc(root, 1);
            const llmOps = ops.map(toLlmDocOperation);
            await api.editDoc(root, llmOps);
            markTargetDirty(root);
            totalApiCalls++;
          } catch (err) {
            errors.push(`${root}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        deleteProposalFile(proposal.id);
        const useJson = opts.format === "json" || isAgentMode();

        if (errors.length > 0 && errors.length === grouped.size) {
          exitWithError("apply_failed", `All operations failed: ${errors.join("; ")}`, "Check node IDs and try again");
        }

        if (useJson) {
          const meta: Record<string, unknown> = {
            command: "ai:apply",
            timestamp: new Date().toISOString(),
            account: config.activeAccount,
            wf_version: "3.0.2",
          };
          const cacheAge = getCacheAgeSeconds();
          if (cacheAge !== null) {
            meta.cache_age_seconds = cacheAge;
            meta.cache_stale = isCacheStale();
          }
          console.log(JSON.stringify({
            meta,
            message: `Applied proposal ${proposal.id} (${proposal.operations.length} operations in ${totalApiCalls} API call${totalApiCalls !== 1 ? "s" : ""})`,
            errors: errors.length > 0 ? errors : undefined,
          }, null, 2));
        } else {
          console.log(`\n  ${chalk.green("✓")} Applied proposal ${chalk.dim(proposal.id)} (${proposal.operations.length} operations in ${totalApiCalls} API call${totalApiCalls !== 1 ? "s" : ""})`);
          if (errors.length > 0) {
            for (const e of errors) console.log(`  ${chalk.red("✗")} ${e}`);
          }
          console.log("");
        }
      }
    });

  program
    .command("ai:reject [id]")
    .description("Discard a pending proposal")
    .option("--format <type>", "Output format (outline|json)")
    .option("--all", "Reject all pending proposals")
    .action((id: string | undefined, opts: { format?: string; all?: boolean }) => {
      const config = loadConfig();

      if (opts.all) {
        const all = listPendingProposals();
        if (all.length === 0) {
          exitWithError("no_proposal", "No pending proposals to reject.", "");
        }
        for (const p of all) deleteProposalFile(p.id);

        if (isAgentMode()) {
          console.log(JSON.stringify({
            meta: { command: "ai:reject", timestamp: new Date().toISOString(), account: config.activeAccount, wf_version: "3.0.2" },
            message: `Rejected ${all.length} proposals.`,
          }, null, 2));
        } else {
          console.log(`\n  ${chalk.red("✗")} Rejected ${all.length} proposals.\n`);
        }
        return;
      }

      let proposal: Proposal | null;
      if (id) {
        proposal = loadProposal(id);
      } else {
        const all = listPendingProposals();
        proposal = all[0] ?? null;
      }

      if (!proposal) {
        exitWithError("no_proposal", "No pending proposal to reject.", "");
      }

      deleteProposalFile(proposal.id);
      const useJson = opts.format === "json" || isAgentMode();

      if (useJson) {
        console.log(JSON.stringify({
          meta: { command: "ai:reject", timestamp: new Date().toISOString(), account: config.activeAccount, wf_version: "3.0.2" },
          message: `Proposal ${proposal.id} rejected.`,
        }, null, 2));
      } else {
        console.log(`\n  ${chalk.red("✗")} Proposal ${chalk.dim(proposal.id)} rejected.\n`);
      }
    });
}

function formatOpDescription(op: ProposalOperation): string {
  switch (op.op) {
    case "move":
      return `${chalk.blue("move")}  "${op.ref_name ?? op.ref}"  ${chalk.dim(op.from_name ?? op.from ?? "")} → ${chalk.cyan(op.under_name ?? op.under ?? "")}`;
    case "complete":
      return `${chalk.green("complete")}  "${op.ref_name ?? op.ref}"`;
    case "uncomplete":
      return `${chalk.yellow("uncomplete")}  "${op.ref_name ?? op.ref}"`;
    case "insert":
      return `${chalk.green("insert")}  "${op.text}" under ${chalk.cyan(op.under_name ?? op.under ?? "")}`;
    case "update":
      return `${chalk.yellow("update")}  "${op.ref_name ?? op.ref}" → "${op.text ?? ""}"`;
    case "delete":
      return `${chalk.red("delete")}  "${op.ref_name ?? op.ref}"`;
    default:
      return `${op.op} ${op.ref ?? ""}`;
  }
}

function groupOperationsByRoot(operations: ProposalOperation[]): Map<string, ProposalOperation[]> {
  const grouped = new Map<string, ProposalOperation[]>();
  for (const op of operations) {
    const root = op.from ?? op.under ?? op.ref ?? "unknown";
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root)!.push(op);
  }
  return grouped;
}

function toLlmDocOperation(op: ProposalOperation): LlmDocOperation {
  switch (op.op) {
    case "move":
      return { op: "move", ref: op.ref!, under: op.under!, position: op.position ?? "top" };
    case "complete":
      return { op: "update", ref: op.ref!, to: { x: 1 } };
    case "uncomplete":
      return { op: "update", ref: op.ref!, to: { x: 0 } };
    case "insert":
      return {
        op: "insert",
        under: op.under!,
        items: [{ n: op.text ?? "", d: op.note, l: op.type !== "bullet" ? op.type : undefined }],
        position: op.position ?? "top",
      };
    case "update":
      return { op: "update", ref: op.ref!, to: { n: op.text } };
    case "delete":
      return { op: "delete", ref: op.ref! };
    default:
      throw new Error(`Unknown operation: ${op.op}`);
  }
}
