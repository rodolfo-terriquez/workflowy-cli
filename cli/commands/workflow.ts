import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

const WORKFLOWS_DIR = join(getConfigDir(), "workflows");

function ensureWorkflowsDir(): void {
  if (!existsSync(WORKFLOWS_DIR)) {
    mkdirSync(WORKFLOWS_DIR, { recursive: true });
  }
}

interface WorkflowStep {
  id: string;
  command: string;
  output?: string;
  when?: string;
  then?: string;
}

interface Workflow {
  name: string;
  description?: string;
  schedule?: string;
  steps: WorkflowStep[];
}

function parseYamlLite(text: string): Workflow {
  const lines = text.split("\n");
  const workflow: Workflow = { name: "", steps: [] };
  let currentStep: Partial<WorkflowStep> | null = null;
  let inSteps = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("name:")) {
      workflow.name = trimmed.slice(5).trim().replace(/^["']|["']$/g, "");
    } else if (trimmed.startsWith("description:")) {
      workflow.description = trimmed.slice(12).trim().replace(/^["']|["']$/g, "");
    } else if (trimmed.startsWith("schedule:")) {
      workflow.schedule = trimmed.slice(9).trim().replace(/^["']|["']$/g, "");
    } else if (trimmed === "steps:") {
      inSteps = true;
    } else if (inSteps && trimmed.startsWith("- id:")) {
      if (currentStep?.id) workflow.steps.push(currentStep as WorkflowStep);
      currentStep = { id: trimmed.slice(5).trim() };
    } else if (inSteps && currentStep) {
      if (trimmed.startsWith("command:")) {
        currentStep.command = trimmed.slice(8).trim().replace(/^["']|["']$/g, "");
      } else if (trimmed.startsWith("output:")) {
        currentStep.output = trimmed.slice(7).trim();
      } else if (trimmed.startsWith("when:")) {
        currentStep.when = trimmed.slice(5).trim().replace(/^["']|["']$/g, "");
      } else if (trimmed.startsWith("then:")) {
        currentStep.then = trimmed.slice(5).trim();
      }
    }
  }

  if (currentStep?.id) workflow.steps.push(currentStep as WorkflowStep);
  return workflow;
}

function interpolateVars(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const parts = key.split(".");
    let val: unknown = vars;
    for (const p of parts) {
      if (val && typeof val === "object") val = (val as Record<string, unknown>)[p];
      else return "";
    }
    return String(val ?? "");
  });
}

function evaluateWhen(expr: string, vars: Record<string, unknown>): boolean {
  const interpolated = interpolateVars(expr, vars);
  const match = interpolated.match(/^(\d+)\s*>\s*(\d+)$/);
  if (match) return Number(match[1]) > Number(match[2]);
  const match2 = interpolated.match(/^(\d+)\s*<\s*(\d+)$/);
  if (match2) return Number(match2[1]) < Number(match2[2]);
  return interpolated !== "0" && interpolated !== "false" && interpolated !== "";
}

export function registerWorkflow(program: Command): void {
  program
    .command("workflow:list")
    .description("List available workflows")
    .action(() => {
      ensureWorkflowsDir();
      const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

      if (isAgentMode()) {
        const workflows = files.map((f) => {
          try {
            const content = readFileSync(join(WORKFLOWS_DIR, f), "utf-8");
            const wf = parseYamlLite(content);
            return { name: wf.name || f.replace(/\.ya?ml$/, ""), description: wf.description, steps: wf.steps.length };
          } catch {
            return { name: f, description: null, steps: 0 };
          }
        });
        console.log(JSON.stringify({ meta: { command: "workflow:list", wf_version: "3.1.4" }, workflows }, null, 2));
        return;
      }

      if (files.length === 0) {
        console.log(chalk.dim("\n  No workflows found. Create one with `wf workflow:create <name>`.\n"));
        return;
      }

      console.log("\n  Workflows:\n");
      for (const f of files) {
        try {
          const content = readFileSync(join(WORKFLOWS_DIR, f), "utf-8");
          const wf = parseYamlLite(content);
          console.log(`  ${chalk.cyan((wf.name || f).padEnd(24))} ${chalk.dim(wf.description ?? "")}  ${chalk.dim(`(${wf.steps.length} steps)`)}`);
        } catch {
          console.log(`  ${chalk.dim(f)} (invalid)`);
        }
      }
      console.log("");
    });

  program
    .command("workflow:create <name>")
    .description("Create a new workflow template")
    .action((name: string) => {
      ensureWorkflowsDir();
      const filePath = join(WORKFLOWS_DIR, `${name}.yaml`);

      if (existsSync(filePath)) {
        exitWithError("already_exists", `Workflow "${name}" already exists`, "");
      }

      const template = `name: ${name}
description: Describe what this workflow does
# schedule: "0 20 * * *"  # optional cron (requires wf watch:start)

steps:
  - id: step-1
    command: node:todos --target @today --format json
    output: todos

  - id: step-2
    command: node:read @inbox --format json
    when: "{{ todos.meta.count }} > 0"
`;

      writeFileSync(filePath, template, "utf-8");

      if (isAgentMode()) {
        console.log(JSON.stringify({ meta: { command: "workflow:create", wf_version: "3.1.4" }, path: filePath }));
      } else {
        console.log(`\n  ${chalk.green("✓")} Created workflow at ${chalk.dim(filePath)}`);
        console.log(`  Edit the file to define your workflow steps.\n`);
      }
    });

  program
    .command("workflow:run <name>")
    .description("Execute a workflow")
    .option("--format <type>", "Output format (outline|json)")
    .action(async (name: string, opts: { format?: string }) => {
      ensureWorkflowsDir();
      const yamlPath = join(WORKFLOWS_DIR, `${name}.yaml`);
      const ymlPath = join(WORKFLOWS_DIR, `${name}.yml`);
      const filePath = existsSync(yamlPath) ? yamlPath : existsSync(ymlPath) ? ymlPath : null;

      if (!filePath) exitWithError("not_found", `Workflow "${name}" not found`, "Run `wf workflow:list`");

      const content = readFileSync(filePath, "utf-8");
      const workflow = parseYamlLite(content);

      if (!isAgentMode()) {
        console.log(`\n  Running workflow: ${chalk.cyan(workflow.name || name)}\n`);
      }

      const vars: Record<string, unknown> = {};
      const results: Array<{ step: string; success: boolean; output?: unknown }> = [];

      for (const step of workflow.steps) {
        if (step.when) {
          const shouldRun = evaluateWhen(step.when, vars);
          if (!shouldRun) {
            if (!isAgentMode()) console.log(`  ${chalk.dim("⏭")} Skipping ${step.id} (condition not met)`);
            results.push({ step: step.id, success: true, output: "skipped" });
            continue;
          }
        }

        const cmd = interpolateVars(step.command, vars);
        if (!isAgentMode()) process.stdout.write(`  ${chalk.dim("▸")} ${step.id}: ${chalk.dim(cmd)}...`);

        try {
          const proc = Bun.spawn(["bun", "run", import.meta.dir + "/../wf.ts", ...cmd.split(/\s+/), "--agent"], {
            stdout: "pipe",
            stderr: "pipe",
          });

          const output = await new Response(proc.stdout).text();
          await proc.exited;

          let parsed: unknown = output;
          try { parsed = JSON.parse(output); } catch { /* keep as string */ }

          if (step.output) {
            vars[step.output] = parsed;
          }

          results.push({ step: step.id, success: true, output: parsed });

          if (!isAgentMode()) console.log(` ${chalk.green("✓")}`);

          if (step.then === "apply" && typeof parsed === "object" && parsed !== null) {
            const proposal = (parsed as Record<string, unknown>).proposal as Record<string, unknown> | undefined;
            if (proposal?.id) {
              const applyProc = Bun.spawn(["bun", "run", import.meta.dir + "/../wf.ts", "ai:apply", String(proposal.id), "--agent"], {
                stdout: "pipe",
              });
              await new Response(applyProc.stdout).text();
              await applyProc.exited;
            }
          }
        } catch (err) {
          results.push({ step: step.id, success: false, output: String(err) });
          if (!isAgentMode()) console.log(` ${chalk.red("✗")} ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (isAgentMode() || opts.format === "json") {
        console.log(JSON.stringify({
          meta: { command: "workflow:run", workflow: name, wf_version: "3.1.4" },
          results,
        }, null, 2));
      } else {
        console.log("");
      }
    });
}
