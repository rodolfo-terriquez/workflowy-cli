import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { resolveTarget } from "../targets.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerAdd(program: Command): void {
  program
    .command("add <target> <text>")
    .description("Add a child node to a target")
    .option("--type <type>", "Node layout (bullet|todo|h1|h2|h3)", "bullet")
    .option("--note <note>", "Note content for the node")
    .option("--position <pos>", "Position: top or bottom", "bottom")
    .option("--after <nodeId>", "Insert after this sibling node")
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        target: string,
        text: string,
        opts: {
          type: string;
          note?: string;
          position: string;
          after?: string;
          format?: string;
        }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);
        const resolved = resolveTarget(target);

        const item: { n: string; d?: string; l?: string } = { n: text };
        if (opts.note) item.d = opts.note;
        if (opts.type !== "bullet") item.l = opts.type;

        if (opts.after) {
          await api.editDoc(resolved.id, [
            {
              op: "insert",
              after: opts.after,
              items: [item],
            },
          ]);
        } else {
          await api.editDoc(resolved.id, [
            {
              op: "insert",
              under: resolved.id,
              items: [item],
              position: opts.position as "top" | "bottom",
            },
          ]);
        }

        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          const config = loadConfig();
          console.log(
            formatJson({
              meta: {
                command: "add",
                target,
                resolved_id: resolved.id,
                timestamp: new Date().toISOString(),
                account: config.activeAccount,
              },
              message: `Added to ${resolved.label}`,
            })
          );
        } else {
          console.log(
            `\n  ${chalk.green("✓")} Added to ${chalk.cyan(resolved.label)}: ${text}\n`
          );
        }
      }
    );
}
