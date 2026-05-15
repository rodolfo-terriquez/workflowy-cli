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

const LOGO = `
${chalk.hex("#44b8f7")("    ╭──────────────────────────╮")}
${chalk.hex("#44b8f7")("    │")}                            ${chalk.hex("#44b8f7")("│")}
${chalk.hex("#44b8f7")("    │")}   ${chalk.hex("#3da3e0")("●")} ${chalk.bold.white("W o r k F l o w y")}      ${chalk.hex("#44b8f7")("│")}
${chalk.hex("#44b8f7")("    │")}     ${chalk.hex("#3da3e0")("●")} ${chalk.dim.white("Command Line")}         ${chalk.hex("#44b8f7")("│")}
${chalk.hex("#44b8f7")("    │")}       ${chalk.hex("#3da3e0")("●")} ${chalk.dim.white("Interface")}          ${chalk.hex("#44b8f7")("│")}
${chalk.hex("#44b8f7")("    │")}                            ${chalk.hex("#44b8f7")("│")}
${chalk.hex("#44b8f7")("    ╰──────────────────────────╯")}
`;

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
  console.log(LOGO);
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
  program.outputHelp();
  process.exit(0);
}

program.parse(process.argv);
