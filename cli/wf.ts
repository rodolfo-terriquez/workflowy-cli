#!/usr/bin/env bun

import { Command } from "commander";
import chalk from "chalk";
import { setAgentMode, isAgentMode } from "./agent.ts";

// Node commands
import { registerNodeRead } from "./commands/read.ts";
import { registerNodeAdd } from "./commands/add.ts";
import { registerNodeMove } from "./commands/move.ts";
import { registerNodeComplete } from "./commands/complete.ts";
import { registerNodeUpdate } from "./commands/update.ts";
import { registerNodeFind } from "./commands/find.ts";
import { registerNodeContext } from "./commands/context.ts";
import { registerNodeDelete } from "./commands/delete.ts";
import { registerNodeTodos } from "./commands/todos.ts";
import { registerNodeBulk } from "./commands/bulk.ts";
import { registerNodeTemplate } from "./commands/template.ts";
import { registerExport } from "./commands/export.ts";

// Search (top-level)
import { registerSearch } from "./commands/search.ts";

// Top-level: tags, targets, history
import { registerTags } from "./commands/tags.ts";
import { registerTargets } from "./commands/targets.ts";
import { registerHistory } from "./commands/history.ts";

// Cache commands
import { registerCacheSync } from "./commands/sync.ts";
import { registerCacheDiff } from "./commands/diff.ts";

// AI commands
import { registerAiCommands } from "./commands/propose.ts";
import { registerProposalsList } from "./commands/proposals.ts";

// Batch (top-level)
import { registerBatch } from "./commands/batch.ts";

// Config commands
import { registerConfigCommands } from "./commands/config.ts";

// Account commands
import { registerAccountCommands } from "./commands/account.ts";

// Watch & Webhooks
import { registerWatch } from "./commands/watch.ts";
import { registerWebhook } from "./commands/webhook.ts";

// Workflows
import { registerWorkflow } from "./commands/workflow.ts";

// Utilities
import { registerDoctor } from "./commands/doctor.ts";
import { registerCompletions } from "./commands/completions.ts";
import { registerLogin } from "./commands/login.ts";
import { registerMcp } from "./commands/mcp.ts";

const VERSION = "3.0.0";

const BANNER = `
${chalk.hex("#3da3e0").bold("  ╦ ╦╔═╗╦═╗╦╔═╔═╗╦  ╔═╗╦ ╦╦ ╦")}
${chalk.hex("#42b0ec").bold("  ║║║║ ║╠╦╝╠╩╗╠╣ ║  ║ ║║║║╚╦╝")}
${chalk.hex("#47b8f5").bold("  ╚╩╝╚═╝╩╚═╩ ╩╚  ╩═╝╚═╝╚╩╝ ╩ ")}

${chalk.dim("  organize your thoughts from the command line")}
${chalk.dim(`  v${VERSION}`)}
`;

function showWelcome(): void {
  if (isAgentMode()) return;
  console.log(BANNER);
  printColoredHelp();
}

function printColoredHelp(): void {
  const c = chalk.hex("#47b8f5");
  const dim = chalk.dim;
  const w = chalk.white;

  console.log(`  ${w("Usage:")} ${c("wf")} ${dim("[command] [options]")}\n`);

  const sections: Array<{ title: string; commands: Array<[string, string]> }> = [
    {
      title: "Node",
      commands: [
        ["node:read [target]",         "Read a node and its children"],
        ["node:add <target> <text>",   "Add a child node to a target"],
        ["node:move <node> <target>",  "Move a node to a different parent"],
        ["node:complete <node>",       "Mark a todo as complete (--undo to uncheck)"],
        ["node:update <node>",         "Rename a node or edit its note"],
        ["node:delete <node>",         "Delete a node"],
        ["node:find <name-or-path>",   "Find nodes by name or @target/path"],
        ["node:context <target>",      "Node + ancestors, siblings, and children"],
        ["node:todos",                 "Query open/completed todos"],
        ["node:bulk <op>",             "Bulk operations (complete|move|delete)"],
        ["node:template <action>",     "Save/apply node templates"],
        ["node:export <target>",       "Export a subtree (outline, JSON, markdown)"],
      ],
    },
    {
      title: "Search & Browse",
      commands: [
        ["search <query>",            "Full-text search (--smart for AI rerank)"],
        ["tags",                       "List all #hashtags with counts"],
        ["targets",                    "List all available @targets"],
        ["history",                    "Recently accessed nodes"],
      ],
    },
    {
      title: "Cache",
      commands: [
        ["cache:sync",                 "Pull full tree into local cache"],
        ["cache:diff",                 "What changed since last sync"],
      ],
    },
    {
      title: "AI",
      commands: [
        ["ai:propose <instruction>",  "Generate a structured diff via LLM"],
        ["ai:preview [id]",           "Re-show a pending proposal"],
        ["ai:apply [id]",             "Execute a pending proposal"],
        ["ai:reject [id]",            "Discard a pending proposal"],
        ["ai:list",                   "List all pending proposals"],
      ],
    },
    {
      title: "Automation",
      commands: [
        ["watch:start",                "Poll for changes, stream NDJSON events"],
        ["watch:stop",                 "Stop the watch daemon"],
        ["watch:status",               "Show watch daemon status"],
        ["webhook:create",             "Fire HTTP POST on matching changes"],
        ["webhook:list",               "List configured webhooks"],
        ["webhook:delete <id>",        "Remove a webhook"],
        ["webhook:test <id>",          "Fire a test payload"],
        ["workflow:run <name>",        "Run a multi-step workflow"],
        ["workflow:list",              "List available workflows"],
        ["workflow:create <name>",     "Create a new workflow"],
      ],
    },
    {
      title: "Config & Account",
      commands: [
        ["config:set <key> <value>",   "Write a config value"],
        ["config:get <key>",           "Read a config value"],
        ["config:alias set|list|remove","Manage command aliases"],
        ["account:list",               "List configured accounts"],
        ["account:switch <name>",      "Switch active account"],
        ["account:current",            "Show active account"],
      ],
    },
    {
      title: "Utilities",
      commands: [
        ["batch",                      "Execute a JSON array of ops from stdin"],
        ["login [apiKey]",             "Authenticate with WorkFlowy"],
        ["doctor",                     "Diagnose common setup issues"],
        ["completions install",        "Install shell completions (bash/zsh/fish)"],
        ["mcp",                        "Start as MCP server (stdio or HTTP)"],
      ],
    },
  ];

  for (const section of sections) {
    console.log(`  ${chalk.bold(section.title)}`);
    for (const [cmd, desc] of section.commands) {
      const padded = cmd.padEnd(28);
      console.log(`    ${c(padded)} ${dim(desc)}`);
    }
    console.log("");
  }

  console.log(`  ${w("Global Options")}`);
  console.log(`    ${c("--agent".padEnd(28))} ${dim("JSON output, no colors")}`);
  console.log(`    ${c("--live".padEnd(28))} ${dim("Bypass cache, hit API directly")}`);
  console.log(`    ${c("--copy".padEnd(28))} ${dim("Copy output to clipboard")}`);
  console.log(`    ${c("--format json|tsv|csv".padEnd(28))} ${dim("Output format")}`);
  console.log(`    ${c("-v, --version".padEnd(28))} ${dim("Show version number")}`);
  console.log(`    ${c("-h, --help".padEnd(28))} ${dim("Show help for any command")}`);
  console.log("");
}

const program = new Command();

program
  .name("wf")
  .description("WorkFlowy CLI — for agents, automations, and power users")
  .version(VERSION, "-v, --version")
  .option("--agent", "Enable agent mode (JSON output, no colors)")
  .option("--copy", "Copy output to clipboard")
  .hook("preAction", () => {
    if (program.opts().agent) {
      setAgentMode(true);
    }
  });

// --- Register all commands ---

// Node group
registerNodeRead(program);
registerNodeAdd(program);
registerNodeMove(program);
registerNodeComplete(program);
registerNodeUpdate(program);
registerNodeDelete(program);
registerNodeFind(program);
registerNodeContext(program);
registerNodeTodos(program);
registerNodeBulk(program);
registerNodeTemplate(program);
registerExport(program);

// Search & browse (top-level)
registerSearch(program);
registerTags(program);
registerTargets(program);
registerHistory(program);

// Cache group
registerCacheSync(program);
registerCacheDiff(program);

// AI group
registerAiCommands(program);
registerProposalsList(program);

// Batch (top-level)
registerBatch(program);

// Config group
registerConfigCommands(program);

// Account group
registerAccountCommands(program);

// Watch & Webhooks
registerWatch(program);
registerWebhook(program);

// Workflows
registerWorkflow(program);

// Utilities
registerMcp(program);
registerDoctor(program);
registerCompletions(program);
registerLogin(program);

// Alias expansion: check config for user-defined aliases before parsing
import { expandAlias } from "./shared/alias.ts";

if (process.argv.length <= 2) {
  if (process.stdin.isTTY) {
    const { startRepl } = await import("./shared/repl.ts");
    showWelcome();
    await startRepl();
  } else {
    showWelcome();
    process.exit(0);
  }
} else {
  const expandedArgs = expandAlias(process.argv);
  program.parse(expandedArgs);
}
