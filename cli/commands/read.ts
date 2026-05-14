import type { Command } from "commander";
import chalk from "chalk";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, loadConfig } from "../shared/config.ts";
import { parseLlmDocResponse } from "../shared/nodes.ts";
import { resolveTarget } from "../targets.ts";
import { formatOutline } from "../output/compact.ts";
import { formatJson } from "../output/json.ts";
import { isAgentMode } from "../agent.ts";

export function registerRead(program: Command): void {
  program
    .command("read [target]")
    .description("Read a node and its children")
    .option("--depth <n>", "Max depth to read", parseInt)
    .option("--format <type>", "Output format (outline|json)")
    .action(
      async (
        target: string | undefined,
        opts: { depth?: number; format?: string }
      ) => {
        const token = requireToken();
        const api = new WorkflowyAPI(token);

        const resolved = resolveTarget(target ?? "@inbox");
        const depth = opts.depth ?? 3;

        const data = await api.readDoc(resolved.id, depth);
        const { node, ancestors } = parseLlmDocResponse(data);
        const useJson = opts.format === "json" || isAgentMode();

        if (useJson) {
          const config = loadConfig();
          console.log(
            formatJson({
              meta: {
                command: "read",
                target: target ?? "@inbox",
                resolved_id: resolved.id,
                timestamp: new Date().toISOString(),
                account: config.activeAccount,
              },
              node: {
                id: node.id,
                name: node.name,
                note: node.note,
                type: node.type,
                completed: node.completed,
                hasMore: false,
                children: [],
              },
              children: node.children,
            })
          );
        } else {
          if (ancestors.length > 0) {
            const breadcrumb = ancestors.map((a) => a.name).join(chalk.dim(" > "));
            console.log(`\n  ${chalk.dim(breadcrumb)}`);
          }
          console.log("");
          console.log(formatOutline(node, opts.depth));
          console.log("");
        }
      }
    );
}
