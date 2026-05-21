import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { WorkflowyAPI } from "../shared/api.ts";
import { requireToken, getConfigDir, loadConfig } from "../shared/config.ts";
import { resolveSavedTargetNodeId } from "../targets.ts";
import { getNodeById, getChildren, getCacheNodeCount, markTargetDirty } from "../shared/cache.ts";
import { cleanHtml } from "../shared/nodes.ts";
import { resolvePathOrId, resolveTargetReference } from "../shared/path.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

const TEMPLATES_DIR = join(getConfigDir(), "templates");

function ensureTemplatesDir(): void {
  if (!existsSync(TEMPLATES_DIR)) {
    mkdirSync(TEMPLATES_DIR, { recursive: true });
  }
}

interface TemplateNode {
  name: string;
  type?: string;
  note?: string;
  children?: TemplateNode[];
}

interface Template {
  name: string;
  nodes: TemplateNode[];
  created_at: string;
}

function substituteVars(text: string): string {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400 * 1000);
  return text
    .replace(/\{\{date\}\}/g, now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }))
    .replace(/\{\{tomorrow\}\}/g, tomorrow.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }))
    .replace(/\{\{title\}\}/g, "Untitled");
}

function buildTemplateFromCache(nodeId: string, maxDepth = 5, depth = 0): TemplateNode {
  const node = getNodeById(nodeId);
  if (!node) return { name: "Unknown" };

  const result: TemplateNode = { name: cleanHtml(node.name) };
  if (node.line_type) result.type = node.line_type;
  if (node.note) result.note = cleanHtml(node.note);

  if (depth < maxDepth) {
    const children = getChildren(nodeId);
    if (children.length > 0) {
      result.children = children.map((c) => buildTemplateFromCache(c.id, maxDepth, depth + 1));
    }
  }

  return result;
}

export function registerNodeTemplate(program: Command): void {
  program
    .command("node:template <action> [name]")
    .description("Manage node templates (list|save|apply|delete)")
    .option("--from <target>", "Source node for save")
    .option("--to <target>", "Destination for apply")
    .option("--format <type>", "Output format (outline|json)")
    .action(async (
      action: string,
      name: string | undefined,
      opts: { from?: string; to?: string; format?: string }
    ) => {
      ensureTemplatesDir();
      const useJson = opts.format === "json" || isAgentMode();

      switch (action) {
        case "list": {
          const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
          const templates = files.map((f) => {
            try {
              const data = JSON.parse(readFileSync(join(TEMPLATES_DIR, f), "utf-8")) as Template;
              return { name: data.name, created_at: data.created_at, node_count: data.nodes.length };
            } catch {
              return null;
            }
          }).filter(Boolean);

          if (useJson) {
            console.log(JSON.stringify({
              meta: { command: "node:template", action: "list", wf_version: "3.0.6" },
              templates,
            }, null, 2));
          } else {
            if (templates.length === 0) {
              console.log(chalk.dim("\n  No templates saved.\n"));
            } else {
              console.log("\n  Templates:\n");
              for (const t of templates) {
                if (t) console.log(`  ${chalk.cyan(t.name.padEnd(24))} ${chalk.dim(t.created_at)}`);
              }
              console.log("");
            }
          }
          break;
        }

        case "save": {
          if (!name) exitWithError("missing_arg", "Template name required", "wf node:template save <name> --from @target");
          if (!opts.from) exitWithError("missing_arg", "--from required for save", "wf node:template save daily-log --from @today");
          if (getCacheNodeCount() === 0) exitWithError("cache_empty", "Cache is empty.", "Run `wf cache:sync` first.");

          let nodeId: string;
          if (opts.from.startsWith("@") && opts.from.includes("/")) {
            const resolved = resolvePathOrId(opts.from);
            if (!resolved) exitWithError("node_not_found", `Path "${opts.from}" not found`, "");
            nodeId = resolved.node.id;
          } else {
            const resolved = resolveTargetReference(opts.from);
            if (!resolved) exitWithError("node_not_found", `Target "${opts.from}" not found`, "Run `wf cache:sync` to refresh path lookups");
            nodeId = resolveSavedTargetNodeId(resolved.id) ?? resolved.id;
          }

          const templateNode = buildTemplateFromCache(nodeId);
          const template: Template = {
            name,
            nodes: [templateNode],
            created_at: new Date().toISOString(),
          };

          writeFileSync(join(TEMPLATES_DIR, `${name}.json`), JSON.stringify(template, null, 2), "utf-8");

          if (useJson) {
            console.log(JSON.stringify({ meta: { command: "node:template", action: "save", wf_version: "3.0.6" }, message: `Template "${name}" saved.` }, null, 2));
          } else {
            console.log(`\n  ${chalk.green("✓")} Template "${chalk.cyan(name)}" saved.\n`);
          }
          break;
        }

        case "apply": {
          if (!name) exitWithError("missing_arg", "Template name required", "wf node:template apply <name> --to @target");
          if (!opts.to) exitWithError("missing_arg", "--to required for apply", "wf node:template apply daily-log --to @today");

          const templatePath = join(TEMPLATES_DIR, `${name}.json`);
          if (!existsSync(templatePath)) exitWithError("not_found", `Template "${name}" not found`, "Run `wf node:template list`");

          const template = JSON.parse(readFileSync(templatePath, "utf-8")) as Template;
          const token = requireToken();
          const api = new WorkflowyAPI(token);
          const resolved = resolveTargetReference(opts.to);
          if (!resolved) exitWithError("node_not_found", `Target "${opts.to}" not found`, "Run `wf cache:sync` to refresh path lookups");

          const items = template.nodes.map(function toItem(n: TemplateNode): { n: string; d?: string; l?: string; c?: unknown[] } {
            const item: { n: string; d?: string; l?: string; c?: unknown[] } = { n: substituteVars(n.name) };
            if (n.note) item.d = substituteVars(n.note);
            if (n.type && n.type !== "bullet") item.l = n.type;
            if (n.children && n.children.length > 0) {
              item.c = n.children.map(toItem);
            }
            return item;
          });

          await api.editDoc(resolved.id, [{
            op: "insert",
            under: resolved.id,
            items,
            position: "top",
          }]);

          markTargetDirty(resolved.id);

          if (useJson) {
            console.log(JSON.stringify({ meta: { command: "node:template", action: "apply", wf_version: "3.0.6" }, message: `Template "${name}" applied to ${opts.to}.` }, null, 2));
          } else {
            console.log(`\n  ${chalk.green("✓")} Template "${chalk.cyan(name)}" applied to ${chalk.cyan(opts.to)}.\n`);
          }
          break;
        }

        case "delete": {
          if (!name) exitWithError("missing_arg", "Template name required", "wf node:template delete <name>");
          const delPath = join(TEMPLATES_DIR, `${name}.json`);
          if (!existsSync(delPath)) exitWithError("not_found", `Template "${name}" not found`, "");
          unlinkSync(delPath);

          if (useJson) {
            console.log(JSON.stringify({ meta: { command: "node:template", action: "delete", wf_version: "3.0.6" }, message: `Template "${name}" deleted.` }, null, 2));
          } else {
            console.log(`\n  ${chalk.red("✗")} Template "${chalk.cyan(name)}" deleted.\n`);
          }
          break;
        }

        default:
          exitWithError("unknown_action", `Unknown action: ${action}`, "Use: list, save, apply, delete");
      }
    });
}
