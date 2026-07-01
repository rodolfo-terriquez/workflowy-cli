import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../shared/config.ts";
import { isAgentMode } from "../agent.ts";
import { exitWithError } from "../shared/errors.ts";

export function registerAccountCommands(program: Command): void {
  program
    .command("account:list")
    .description("List configured accounts")
    .action(() => {
      const config = loadConfig();
      const accounts = Object.keys(config.accounts);

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "account:list", wf_version: "3.1.5" },
          accounts: accounts.map((name) => ({
            name,
            active: name === config.activeAccount,
          })),
          active_account: config.activeAccount,
        }, null, 2));
        return;
      }

      if (accounts.length === 0) {
        console.log(chalk.dim("\n  No accounts configured. Run `wf login` first.\n"));
        return;
      }

      console.log("\n  Accounts:\n");
      for (const name of accounts) {
        const active = name === config.activeAccount;
        const icon = active ? chalk.green("●") : chalk.dim("○");
        const label = active ? chalk.bold(name) : name;
        console.log(`  ${icon} ${label}${active ? chalk.dim(" (active)") : ""}`);
      }
      console.log("");
    });

  program
    .command("account:switch <name>")
    .description("Switch active account")
    .action((name: string) => {
      const config = loadConfig();

      if (!(name in config.accounts)) {
        exitWithError(
          "account_not_found",
          `Account "${name}" not found`,
          `Available: ${Object.keys(config.accounts).join(", ") || "none — run wf login --account <name> first"}`
        );
      }

      config.activeAccount = name;
      saveConfig(config);

      if (isAgentMode()) {
        console.log(JSON.stringify({ meta: { command: "account:switch", wf_version: "3.1.5" }, active_account: name }));
      } else {
        console.log(`\n  ${chalk.green("✓")} Switched to account ${chalk.bold(name)}\n`);
      }
    });

  program
    .command("account:current")
    .description("Show active account")
    .action(() => {
      const config = loadConfig();

      if (isAgentMode()) {
        console.log(JSON.stringify({
          meta: { command: "account:current", wf_version: "3.1.5" },
          active_account: config.activeAccount,
          has_token: !!config.accounts[config.activeAccount]?.token,
        }));
      } else {
        console.log(`\n  Active account: ${chalk.bold(config.activeAccount)}\n`);
      }
    });
}
