#!/usr/bin/env bun

import { Command } from "commander";
import chalk from "chalk";
import { setAgentMode, isAgentMode } from "./agent.ts";
import { registerLogin } from "./commands/login.ts";
import { registerTargets } from "./commands/targets.ts";
import { registerRead } from "./commands/read.ts";
import { registerSearch } from "./commands/search.ts";
import { registerCapture } from "./commands/capture.ts";
import { registerAdd } from "./commands/add.ts";
import { registerMove } from "./commands/move.ts";
import { registerComplete } from "./commands/complete.ts";
import { registerExport } from "./commands/export.ts";
import { registerPropose } from "./commands/propose.ts";
import { registerSync } from "./commands/sync.ts";
import { registerFind } from "./commands/find.ts";
import { registerContext } from "./commands/context.ts";
import { registerBatch } from "./commands/batch.ts";
import { registerConfig } from "./commands/config.ts";
import { registerDiff } from "./commands/diff.ts";

const VERSION = "0.2.0";

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
      title: "Read & Navigate",
      commands: [
        ["read [target]",         "Read a node and its children"],
        ["search <query>",        "Full-text search across all nodes"],
        ["find <name-or-path>",   "Find nodes by name or @target/path"],
        ["context <target>",      "Node + ancestors, siblings, and children"],
        ["targets",               "List all available @targets"],
        ["export <target>",       "Export a subtree (outline, JSON, markdown)"],
      ],
    },
    {
      title: "Write",
      commands: [
        ["capture <text>",        "Quick-add to inbox (or --to @target)"],
        ["add <target> <text>",   "Add a child node to a target"],
        ["move <node> <target>",  "Move a node to a different parent"],
        ["complete <node>",       "Mark a todo as complete (--undo to uncheck)"],
        ["batch",                 "Execute a JSON array of ops from stdin"],
      ],
    },
    {
      title: "Sync & Diff",
      commands: [
        ["sync",                  "Pull full tree into local cache"],
        ["diff",                  "What changed since last sync"],
      ],
    },
    {
      title: "Propose & Apply",
      commands: [
        ["propose <instruction>", "Generate a structured diff via LLM"],
        ["preview",               "Re-show the pending proposal"],
        ["apply",                 "Execute the pending proposal"],
        ["reject",                "Discard the pending proposal"],
      ],
    },
    {
      title: "Setup",
      commands: [
        ["login [apiKey]",        "Authenticate with WorkFlowy"],
        ["config get|set <key>",  "Manage CLI configuration"],
      ],
    },
  ];

  for (const section of sections) {
    console.log(`  ${chalk.bold(section.title)}`);
    for (const [cmd, desc] of section.commands) {
      const padded = cmd.padEnd(24);
      console.log(`    ${c(padded)} ${dim(desc)}`);
    }
    console.log("");
  }

  console.log(`  ${w("Options")}`);
  console.log(`    ${c("--agent".padEnd(24))} ${dim("JSON output, no colors")}`);
  console.log(`    ${c("--live".padEnd(24))} ${dim("Bypass cache, hit API directly")}`);
  console.log(`    ${c("--format json|markdown".padEnd(24))} ${dim("Output format")}`);
  console.log(`    ${c("-v, --version".padEnd(24))} ${dim("Show version number")}`);
  console.log(`    ${c("-h, --help".padEnd(24))} ${dim("Show help for any command")}`);
  console.log("");
}

const program = new Command();

program
  .name("wf")
  .description("WorkFlowy CLI — for agents, automations, and power users")
  .version(VERSION, "-v, --version")
  .option("--agent", "Enable agent mode (JSON output, no colors)")
  .hook("preAction", () => {
    if (program.opts().agent) {
      setAgentMode(true);
    }
  });

registerLogin(program);
registerTargets(program);
registerRead(program);
registerSearch(program);
registerCapture(program);
registerAdd(program);
registerMove(program);
registerComplete(program);
registerExport(program);
registerPropose(program);
registerSync(program);
registerFind(program);
registerContext(program);
registerBatch(program);
registerConfig(program);
registerDiff(program);

if (process.argv.length <= 2) {
  showWelcome();
  process.exit(0);
}

program.parse(process.argv);
